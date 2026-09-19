ALTER TABLE chain_deployment ADD COLUMN settlement_contract text CHECK(settlement_contract ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN payment_token text CHECK(payment_token ~ '^0x[0-9a-f]{40}$'),
  ADD COLUMN bank_wallet_id uuid REFERENCES wallet_binding;
ALTER TABLE bank_review ADD COLUMN version integer NOT NULL DEFAULT 1,
  ADD COLUMN reviewer_id uuid REFERENCES app_user, ADD COLUMN internal_note text,
  ADD COLUMN public_message text, ADD COLUMN updated_at timestamptz NOT NULL DEFAULT now();
CREATE TABLE bank_review_entry (
  id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES bank_review, actor_id uuid NOT NULL REFERENCES app_user,
  action text NOT NULL, internal_note text, public_message text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE bank_supplement (
  id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES bank_review,
  request text NOT NULL, requested_by uuid NOT NULL REFERENCES app_user,
  status text NOT NULL DEFAULT 'REQUESTED' CHECK(status IN ('REQUESTED','SUBMITTED','CLOSED')),
  response text, submitted_by uuid REFERENCES app_user, submitted_at timestamptz,
  closed_by uuid REFERENCES app_user, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE offer_approval (
  id uuid PRIMARY KEY, review_id uuid NOT NULL REFERENCES bank_review, receivable_id uuid NOT NULL REFERENCES receivable,
  snapshot_hash text NOT NULL, purchase_amount bigint NOT NULL CHECK(purchase_amount > 0),
  expires_at timestamptz NOT NULL, bank_wallet_id uuid NOT NULL REFERENCES wallet_binding,
  approved_by uuid NOT NULL REFERENCES app_user, approval_reference text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE settlement_offer (
  id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES chain_deployment, offer_id numeric(78,0) NOT NULL,
  receivable_id uuid NOT NULL REFERENCES receivable, approval_id uuid UNIQUE REFERENCES offer_approval,
  approval_reference text NOT NULL, bank_address text NOT NULL, purchase_amount bigint NOT NULL CHECK(purchase_amount>0),
  expires_at timestamptz NOT NULL, status text NOT NULL CHECK(status IN ('ACTIVE','WITHDRAWN','EXPIRED','ACCEPTED','INVALIDATED')),
  created_tx_hash text NOT NULL, created_at timestamptz NOT NULL, UNIQUE(deployment_id,offer_id)
);
CREATE TABLE wallet_operation (
  id uuid PRIMARY KEY, receivable_id uuid NOT NULL REFERENCES receivable, deployment_id uuid NOT NULL REFERENCES chain_deployment,
  actor_id uuid NOT NULL REFERENCES app_user, organization_id uuid NOT NULL REFERENCES organization,
  kind text NOT NULL CHECK(kind IN ('CREATE_OFFER','WITHDRAW_OFFER','ACCEPT_OFFER','REPAY','CANCEL')),
  idempotency_key uuid NOT NULL, request_hash text NOT NULL,
  payment_approval jsonb, sender_address text NOT NULL, to_address text NOT NULL, calldata text NOT NULL,
  status text NOT NULL DEFAULT 'AWAITING_SIGNATURE' CHECK(status IN ('AWAITING_SIGNATURE','PENDING','CONFIRMED','FAILED','USER_REJECTED')),
  tx_hash text, failure_code text, confirmed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(organization_id,idempotency_key)
);
CREATE TABLE settlement_event (
  id uuid PRIMARY KEY, deployment_id uuid NOT NULL REFERENCES chain_deployment,
  receivable_id uuid NOT NULL REFERENCES receivable, tx_hash text NOT NULL,
  log_index integer NOT NULL, block_number bigint NOT NULL, block_hash text NOT NULL,
  event_type text NOT NULL, payload jsonb NOT NULL, occurred_at timestamptz NOT NULL,
  UNIQUE(deployment_id,tx_hash,log_index)
);
CREATE TABLE settlement_cursor (
  deployment_id uuid PRIMARY KEY REFERENCES chain_deployment, block_number bigint NOT NULL, block_hash text NOT NULL
);
ALTER TABLE receivable ADD COLUMN purchase_tx_hash text, ADD COLUMN purchased_at timestamptz,
  ADD COLUMN repayment_tx_hash text, ADD COLUMN repaid_at timestamptz,
  ADD COLUMN cancellation_tx_hash text, ADD COLUMN cancelled_at timestamptz;
CREATE TRIGGER immutable_offer_approval BEFORE UPDATE OR DELETE ON offer_approval FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_bank_entry BEFORE UPDATE OR DELETE ON bank_review_entry FOR EACH ROW EXECUTE FUNCTION reject_mutation();
-- Demo users may hold both roles; authorization and actor records remain distinct.
INSERT INTO membership_role(membership_id,role) SELECT membership_id,'BANK_APPROVER' FROM membership_role WHERE role='BANK_REVIEWER' ON CONFLICT DO NOTHING;
CREATE FUNCTION guard_settlement_wallet_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.address,NEW.chain_id,NEW.organization_id) IS DISTINCT FROM (OLD.address,OLD.chain_id,OLD.organization_id)
    AND (EXISTS(SELECT 1 FROM chain_deployment WHERE bank_wallet_id=OLD.id)
      OR EXISTS(SELECT 1 FROM offer_approval WHERE bank_wallet_id=OLD.id))
    THEN RAISE EXCEPTION 'settlement wallet identity is immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_wallet_identity BEFORE UPDATE ON wallet_binding FOR EACH ROW EXECUTE FUNCTION guard_settlement_wallet_identity();
