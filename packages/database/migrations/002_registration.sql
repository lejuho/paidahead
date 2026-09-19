CREATE TABLE chain_deployment (
  id uuid PRIMARY KEY, chain_id bigint NOT NULL CHECK(chain_id > 0),
  receivable_contract text NOT NULL CHECK(receivable_contract ~ '^0x[0-9a-f]{40}$'),
  registrar_address text NOT NULL CHECK(registrar_address ~ '^0x[0-9a-f]{40}$'),
  deployment_block bigint NOT NULL CHECK(deployment_block >= 0),
  confirmations integer NOT NULL DEFAULT 1 CHECK(confirmations > 0),
  environment text NOT NULL CHECK(environment IN ('local','testnet')),
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chain_id,receivable_contract)
);
CREATE UNIQUE INDEX one_active_deployment ON chain_deployment(active) WHERE active;
CREATE UNIQUE INDEX one_approved_wallet ON wallet_binding(organization_id,chain_id)
  WHERE verification_status='APPROVED' AND approved_at IS NOT NULL;

CREATE TABLE receivable (
  id uuid PRIMARY KEY, application_id uuid NOT NULL UNIQUE REFERENCES application,
  revision_id uuid NOT NULL, confirmation_id uuid NOT NULL UNIQUE REFERENCES buyer_confirmation,
  unique_trade_key text NOT NULL UNIQUE CHECK(unique_trade_key ~ '^0x[0-9a-f]{64}$'),
  snapshot_hash text NOT NULL, confirmation_reference_hash text NOT NULL,
  supplier_org_id uuid NOT NULL REFERENCES organization, buyer_org_id uuid NOT NULL REFERENCES organization,
  bank_org_id uuid NOT NULL REFERENCES organization,
  supplier_wallet_id uuid NOT NULL REFERENCES wallet_binding, payer_wallet_id uuid NOT NULL REFERENCES wallet_binding,
  face_amount bigint NOT NULL CHECK(face_amount > 0), currency text NOT NULL DEFAULT 'KRW' CHECK(currency='KRW'),
  due_at timestamptz NOT NULL, deployment_id uuid NOT NULL REFERENCES chain_deployment,
  token_id numeric(78,0) NOT NULL CHECK(token_id > 0 AND token_id < 2::numeric^256),
  chain_status text CHECK(chain_status IN ('REGISTERED','PURCHASED','REPAID','CANCELLED')),
  holder_wallet_id uuid REFERENCES wallet_binding,
  registration_tx_hash text, registered_at timestamptz, synced_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(application_id,revision_id) REFERENCES application_revision(application_id,id),
  FOREIGN KEY(revision_id,snapshot_hash) REFERENCES application_revision(id,snapshot_hash),
  UNIQUE(deployment_id,token_id)
);
CREATE TABLE chain_operation (
  id uuid PRIMARY KEY, kind text NOT NULL DEFAULT 'REGISTER' CHECK(kind='REGISTER'),
  application_id uuid NOT NULL REFERENCES application, revision_id uuid NOT NULL,
  confirmation_id uuid NOT NULL UNIQUE REFERENCES buyer_confirmation,
  idempotency_key text NOT NULL UNIQUE, receivable_id uuid UNIQUE REFERENCES receivable,
  deployment_id uuid REFERENCES chain_deployment,
  status text NOT NULL DEFAULT 'NOT_SUBMITTED' CHECK(status IN ('NOT_SUBMITTED','PENDING','CONFIRMED','FAILED','INVALIDATED')),
  failure_code text, attempt_count integer NOT NULL DEFAULT 0,
  confirmed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(application_id,revision_id) REFERENCES application_revision(application_id,id),
  CHECK((receivable_id IS NULL) = (deployment_id IS NULL))
);
CREATE INDEX registration_queue ON chain_operation(status,created_at);
CREATE TABLE chain_transaction (
  id uuid PRIMARY KEY, operation_id uuid NOT NULL REFERENCES chain_operation,
  chain_id bigint NOT NULL, sender_address text NOT NULL, nonce bigint NOT NULL CHECK(nonce>=0),
  tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
  signed_transaction text NOT NULL CHECK(signed_transaction ~ '^0x[0-9a-f]+$'),
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','REVERTED')),
  block_number bigint, block_hash text, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chain_id,tx_hash), UNIQUE(chain_id,sender_address,nonce)
);
CREATE TABLE chain_event (
  id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES chain_deployment,
  transaction_id uuid NOT NULL REFERENCES chain_transaction, chain_id bigint NOT NULL,
  contract_address text NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL,
  block_number bigint NOT NULL, block_hash text NOT NULL, event_type text NOT NULL,
  payload jsonb NOT NULL, processed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,tx_hash,log_index)
);
CREATE TABLE bank_review (
  id uuid PRIMARY KEY, receivable_id uuid NOT NULL UNIQUE REFERENCES receivable,
  bank_org_id uuid NOT NULL REFERENCES organization, reviewed_snapshot_hash text NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_REVIEW','NEEDS_INFO','APPROVED_FOR_OFFER','DECLINED')),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Keep the wallet identity immutable once bound to an issuance; approval may still be revoked.
CREATE FUNCTION guard_registered_wallet_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.address,NEW.chain_id,NEW.organization_id) IS DISTINCT FROM (OLD.address,OLD.chain_id,OLD.organization_id)
    AND EXISTS(SELECT 1 FROM receivable WHERE supplier_wallet_id=OLD.id OR payer_wallet_id=OLD.id)
    THEN RAISE EXCEPTION 'reserved wallet identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registered_wallet_identity BEFORE UPDATE ON wallet_binding FOR EACH ROW EXECUTE FUNCTION guard_registered_wallet_identity();

-- Registration and revision mutation use the same application row lock.
CREATE FUNCTION guard_reserved_application() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_revision_id <> OLD.current_revision_id AND EXISTS(SELECT 1 FROM receivable WHERE application_id=OLD.id)
    THEN RAISE EXCEPTION 'registration reserved: revision locked' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registration_revision_lock BEFORE UPDATE ON application FOR EACH ROW EXECUTE FUNCTION guard_reserved_application();
CREATE FUNCTION guard_reserved_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM receivable WHERE confirmation_id=OLD.id)
    THEN RAISE EXCEPTION 'registration reserved: confirmation locked' USING ERRCODE='23514'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER registration_confirmation_lock BEFORE UPDATE OR DELETE ON buyer_confirmation
  FOR EACH ROW EXECUTE FUNCTION guard_reserved_confirmation();

-- Queue already confirmed current versions when upgrading an existing demo DB.
INSERT INTO chain_operation(id,application_id,revision_id,confirmation_id,idempotency_key)
SELECT gen_random_uuid(),cf.application_id,cf.revision_id,cf.id,'register:'||cf.id
FROM buyer_confirmation cf JOIN application a ON a.id=cf.application_id
WHERE cf.status='CONFIRMED' AND a.current_revision_id=cf.revision_id;
