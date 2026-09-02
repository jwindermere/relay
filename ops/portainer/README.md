# Portainer deployment on UmbrelOS

This deployment publishes only Relay's web process on host port `9095`. PostgreSQL,
the worker, migrations, backups, and evaluation retention remain private. Nginx Proxy
Manager terminates TLS and forwards `relay.hades.ws` to `192.168.0.112:9095`.

## 1. Publish the image

Create a Docker Hub repository named `relay`. In the GitHub repository settings, add:

- Actions variable `DOCKERHUB_USERNAME`: the Docker Hub account or organisation.
- Actions secret `DOCKERHUB_TOKEN`: a Docker Hub access token with read/write access
  to that repository. Do not use the account password.

Every successful CI run caused by a push to `main` publishes Linux AMD64 and ARM64
images tagged `latest` and `sha-<full commit SHA>`.

## 2. Generate the Portainer environment

Umbrel's App Store version of Portainer runs a nested Docker daemon. Do not create
host directories or use bind mounts: Umbrel warns that bind-mounted Portainer data
is lost when the Portainer app restarts or updates. This stack uses named volumes for
PostgreSQL, Codex state, agent workspaces, and local database backups.

Run the setup wizard from this checkout on your own computer, not on UmbrelOS:

```sh
ops/portainer/provision-host.sh
```

It writes a mode-`0600`, gitignored `ops/portainer/stack.env` containing the stack
configuration and generated secrets. You will need the GitHub App ID and its
downloaded private-key PEM. The generated `DATABASE_URL` uses the Compose service
hostname and the same generated PostgreSQL password:

```text
postgres://relay:YOUR_URL_ENCODED_PASSWORD@postgres:5432/relay
```

The PEM is stored as one environment value with literal `\n` separators; Relay
converts those separators back to line breaks. Treat `stack.env` as a password file.
Portainer also stores these values in its own persistent named volume.

## 3. Create the Portainer stack

Create a Git-backed stack from this repository and set the Compose path to
`compose.portainer.yaml`. Load or enter every value from the generated `stack.env` in
Portainer's environment-variable editor. Do not commit that file.
If the Docker Hub repository is private, first add its credentials under Portainer's
Registries settings and associate that registry with the environment.

Deploy the stack and wait for `migrate` to finish successfully, then confirm `web`,
`worker`, `backup`, and `evaluation-retention` are running and `postgres` is healthy.
From another machine on the LAN, verify:

```sh
curl --fail http://192.168.0.112:9095/health
```

In Nginx Proxy Manager, use `http`, forward hostname/IP `192.168.0.112`, forward port
`9095`, enable Websockets Support, request a certificate for `relay.hades.ws`, and
enable Force SSL. The stack fixes the application origin and authentication base URL
to `https://relay.hades.ws` through `RELAY_HOSTNAME`.

With `RELAY_INVITATION_DELIVERY_MODE=manual`, send each generated invitation link to
the intended recipient through a trusted channel. Relay treats its one-time 24-hour
secret as verification for that invitation only. Email notifications and password
recovery remain unavailable.

## 4. Bootstrap the owner

Open a console on the running `web` container and run this once, substituting the
real values:

```sh
RELAY_OWNER_PASSWORD='use-a-long-unique-password' npm run start:bootstrap-owner -- \
  --email owner@example.com \
  --name 'Provider account owner' \
  --workspace 'MVP pilot workspace'
```

The command uses the database URL already present in that container's environment and
refuses to bootstrap a second owner.

## Persistence and upgrades

The `postgres-data` and `database-backups` volumes both live inside Umbrel Portainer's
persistent Docker data. The scheduled dumps protect against an accidental database
change, but they do not protect against loss of the Umbrel disk or the Portainer app's
entire data directory. Umbrel's system backup or a later exported copy is still needed
for disaster recovery.

Do not enable Watchtower for Relay and do not use Portainer's generic "pull and
redeploy" control for routine upgrades. The worker has a 30-minute drain boundary,
and schema changes must be backed up and migrated between runtime replacements.

Pin `RELAY_IMAGE` to a published `sha-...` tag for routine releases. Before updating
the stack, stop the worker with a 30-minute timeout, run `/ops/postgres/backup.sh` in
the backup container, change the image tag, and redeploy. The one-shot `migrate`
service must exit successfully before the new web and worker start. Keep the previous
SHA tag as the rollback target.
