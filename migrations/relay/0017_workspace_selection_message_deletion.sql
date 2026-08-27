ALTER TABLE public.message
  ADD COLUMN deleted_at timestamptz,
  ADD COLUMN deleted_by_workspace_member_id text,
  ADD CONSTRAINT message_deleted_by_workspace_member_fkey
    FOREIGN KEY (deleted_by_workspace_member_id, workspace_id)
    REFERENCES public.workspace_member(id, workspace_id) ON DELETE RESTRICT,
  ADD CONSTRAINT message_deletion_result_check CHECK (
    (deleted_at IS NULL AND deleted_by_workspace_member_id IS NULL)
    OR (deleted_at IS NOT NULL AND deleted_by_workspace_member_id IS NOT NULL)
  );

CREATE INDEX workspace_membership_active_user_joined_idx
  ON public.workspace_membership (user_id, joined_at, workspace_id)
  WHERE revoked_at IS NULL;
