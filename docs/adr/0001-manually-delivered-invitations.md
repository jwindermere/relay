# Permit explicit manually delivered invitations

Self-hosted Relay may explicitly treat possession of an email-bound, one-time,
24-hour invitation as sufficient verification for the invited account. Email
verification remains the default because it proves mailbox control; manual delivery
supports installations without an email gateway, records `invitation_token` as the
verification evidence, and leaves password recovery and email notifications
unavailable until email delivery is configured.
