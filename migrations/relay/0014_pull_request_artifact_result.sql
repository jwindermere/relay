ALTER TABLE public.artifact
  ADD COLUMN result_message_id text UNIQUE,
  ADD CONSTRAINT artifact_result_message_workspace_fkey
    FOREIGN KEY (result_message_id, workspace_id)
    REFERENCES public.message(id, workspace_id) ON DELETE RESTRICT;

INSERT INTO public.message (
  id, workspace_id, channel_id, author_workspace_member_id, parent_message_id, body
)
SELECT 'artifact-result:' || artifact.id,
       artifact.workspace_id,
       source.channel_id,
       agent_member.id,
       COALESCE(source.parent_message_id, source.id),
       'Completed the engineering request. Pull request #' || artifact.pull_request_number
         || ' is ready for human review.'
FROM public.artifact artifact
JOIN public.agent_run run
  ON run.id = artifact.agent_run_id AND run.workspace_id = artifact.workspace_id
JOIN public.task task
  ON task.id = artifact.task_id AND task.workspace_id = artifact.workspace_id
JOIN public.message source
  ON source.id = task.source_message_id AND source.workspace_id = artifact.workspace_id
JOIN public.workspace_member agent_member
  ON agent_member.agent_id = run.agent_id
 AND agent_member.workspace_id = artifact.workspace_id
WHERE artifact.result_message_id IS NULL
ON CONFLICT (id) DO NOTHING;

UPDATE public.artifact
SET result_message_id = 'artifact-result:' || id
WHERE result_message_id IS NULL;

INSERT INTO public.notification_outbox (workspace_id, message_id, topic, payload)
SELECT artifact.workspace_id, artifact.result_message_id, 'channel.message',
       jsonb_build_object('messageId', artifact.result_message_id)
FROM public.artifact artifact
ON CONFLICT (message_id) DO NOTHING;

ALTER TABLE public.artifact
  ALTER COLUMN result_message_id SET NOT NULL;
