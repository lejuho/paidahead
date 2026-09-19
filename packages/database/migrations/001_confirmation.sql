CREATE TABLE organization (
  id uuid PRIMARY KEY, name text NOT NULL, display_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('SUPPLIER','BUYER','BANK','PLATFORM')),
  approval_status text NOT NULL CHECK (approval_status IN ('PENDING','APPROVED','REVOKED')),
  is_demo boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE app_user (
  id uuid PRIMARY KEY, auth_provider text NOT NULL, auth_subject text NOT NULL,
  display_name text NOT NULL, status text NOT NULL CHECK (status IN ('ACTIVE','DISABLED')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(auth_provider, auth_subject)
);
CREATE TABLE user_membership (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES app_user,
  organization_id uuid NOT NULL REFERENCES organization,
  status text NOT NULL CHECK (status IN ('ACTIVE','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(user_id, organization_id)
);
CREATE TABLE membership_role (
  membership_id uuid NOT NULL REFERENCES user_membership, role text NOT NULL,
  PRIMARY KEY(membership_id, role)
);
CREATE TABLE demo_session (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid NOT NULL REFERENCES app_user, expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE wallet_binding (
  id uuid PRIMARY KEY, organization_id uuid NOT NULL REFERENCES organization,
  chain_id bigint NOT NULL CHECK (chain_id > 0), address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$'),
  verification_status text NOT NULL, approved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(chain_id, address)
);
CREATE TABLE document (
  id uuid PRIMARY KEY, owner_org_id uuid NOT NULL REFERENCES organization,
  document_type text NOT NULL CHECK (document_type IN ('PURCHASE_ORDER','DELIVERY_NOTE','INVOICE')),
  original_filename text NOT NULL, storage_key text NOT NULL UNIQUE,
  mime_type text NOT NULL, file_size bigint NOT NULL CHECK (file_size > 0),
  file_hash text NOT NULL CHECK (file_hash ~ '^[0-9a-f]{64}$'),
  uploaded_by uuid NOT NULL REFERENCES app_user, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE application (
  id uuid PRIMARY KEY, supplier_org_id uuid NOT NULL REFERENCES organization,
  current_revision_id uuid NOT NULL, created_by uuid NOT NULL REFERENCES app_user,
  lock_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE application_revision (
  id uuid PRIMARY KEY, application_id uuid NOT NULL REFERENCES application,
  version integer NOT NULL CHECK (version > 0), buyer_org_id uuid NOT NULL REFERENCES organization,
  target_bank_org_id uuid NOT NULL REFERENCES organization,
  trade_reference text NOT NULL, title text NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT','REVIEW_REQUIRED','REVIEW_COMPLETED')),
  confirmed_amount bigint NOT NULL CHECK (confirmed_amount > 0), currency text NOT NULL DEFAULT 'KRW' CHECK (currency = 'KRW'),
  confirmed_due_at timestamptz NOT NULL, confirmed_fields jsonb,
  reviewed_fields_hash text CHECK (reviewed_fields_hash ~ '^0x[0-9a-f]{64}$'),
  review_completed_by uuid REFERENCES app_user, review_completed_at timestamptz,
  consented_by uuid REFERENCES app_user, consent_version text, submission_consent_at timestamptz,
  snapshot_hash text CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'), snapshot_schema_version integer NOT NULL DEFAULT 1,
  frozen_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(application_id, version), UNIQUE(application_id, id), UNIQUE(id, buyer_org_id), UNIQUE(id, snapshot_hash),
  CHECK (status <> 'REVIEW_COMPLETED' OR
    (confirmed_fields IS NOT NULL AND reviewed_fields_hash IS NOT NULL AND review_completed_by IS NOT NULL AND review_completed_at IS NOT NULL)),
  CHECK (frozen_at IS NULL OR
    (snapshot_hash IS NOT NULL AND consented_by IS NOT NULL AND consent_version IS NOT NULL AND submission_consent_at IS NOT NULL AND status = 'REVIEW_COMPLETED'))
);
ALTER TABLE application ADD CONSTRAINT current_revision_belongs_to_application
  FOREIGN KEY(id, current_revision_id) REFERENCES application_revision(application_id, id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE revision_document (
  revision_id uuid NOT NULL REFERENCES application_revision, document_id uuid NOT NULL REFERENCES document,
  PRIMARY KEY(revision_id, document_id)
);
CREATE TABLE review_issue (
  id uuid PRIMARY KEY, revision_id uuid NOT NULL REFERENCES application_revision,
  field_name text NOT NULL, reason text NOT NULL,
  resolution_status text NOT NULL DEFAULT 'OPEN' CHECK (resolution_status IN ('OPEN','RESOLVED')),
  resolution_note text, resolved_by uuid REFERENCES app_user, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE buyer_confirmation (
  id uuid PRIMARY KEY, application_id uuid NOT NULL, revision_id uuid NOT NULL,
  buyer_org_id uuid NOT NULL, snapshot_hash text NOT NULL CHECK (snapshot_hash ~ '^0x[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('PENDING','CONFIRMED','REJECTED','WITHDRAWN','INVALIDATED')),
  requested_by uuid NOT NULL REFERENCES app_user, requested_at timestamptz NOT NULL DEFAULT now(),
  confirmed_by uuid REFERENCES app_user, confirmed_at timestamptz,
  delivery_acknowledged boolean NOT NULL DEFAULT false, payment_obligation_acknowledged boolean NOT NULL DEFAULT false,
  rejected_by uuid REFERENCES app_user, rejected_at timestamptz, rejection_reason text,
  withdrawn_at timestamptz, invalidated_at timestamptz,
  FOREIGN KEY(application_id, revision_id) REFERENCES application_revision(application_id, id),
  FOREIGN KEY(revision_id, buyer_org_id) REFERENCES application_revision(id, buyer_org_id),
  FOREIGN KEY(revision_id, snapshot_hash) REFERENCES application_revision(id, snapshot_hash),
  CHECK (status <> 'CONFIRMED' OR (confirmed_by IS NOT NULL AND confirmed_at IS NOT NULL AND delivery_acknowledged AND payment_obligation_acknowledged)),
  CHECK (status <> 'REJECTED' OR (rejected_by IS NOT NULL AND rejected_at IS NOT NULL AND length(trim(rejection_reason)) > 0))
);
CREATE UNIQUE INDEX uq_live_confirmation ON buyer_confirmation(revision_id) WHERE status IN ('PENDING','CONFIRMED');
CREATE TABLE audit_log (
  id uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES app_user,
  organization_id uuid NOT NULL REFERENCES organization,
  action text NOT NULL, target_type text NOT NULL, target_id uuid NOT NULL,
  previous_value jsonb, new_value jsonb, reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX applications_supplier ON application(supplier_org_id, created_at);
CREATE INDEX confirmations_buyer ON buyer_confirmation(buyer_org_id, status, requested_at);
CREATE INDEX confirmations_application ON buyer_confirmation(application_id);
CREATE INDEX audit_target ON audit_log(target_type, target_id, created_at);

CREATE FUNCTION guard_frozen_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.frozen_at IS NOT NULL THEN RAISE EXCEPTION 'frozen revision is immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frozen_revision BEFORE UPDATE OR DELETE ON application_revision
  FOR EACH ROW EXECUTE FUNCTION guard_frozen_revision();

CREATE FUNCTION guard_revision_document() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE rid uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN RAISE EXCEPTION 'replace attachment by delete and insert' USING ERRCODE = '23514'; END IF;
  rid := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision_id ELSE NEW.revision_id END;
  PERFORM id FROM application_revision WHERE id = rid FOR UPDATE;
  IF EXISTS (SELECT 1 FROM application_revision WHERE id = rid AND frozen_at IS NOT NULL)
    THEN RAISE EXCEPTION 'frozen attachment is immutable' USING ERRCODE = '23514'; END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER frozen_attachment BEFORE INSERT OR UPDATE OR DELETE ON revision_document
  FOR EACH ROW EXECUTE FUNCTION guard_revision_document();

CREATE FUNCTION reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'append-only record' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER immutable_document BEFORE UPDATE OR DELETE ON document FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW EXECUTE FUNCTION reject_mutation();
