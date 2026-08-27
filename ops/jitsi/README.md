# Self-hosted Jitsi for Relay

Relay is prepared for this production layout:

| Service | Public address | Ingress |
| --- | --- | --- |
| Relay | `https://relay.hades.ws` | TCP 443 through Caddy |
| Jitsi web | `https://meet.hades.ws` | TCP 443 through the same Caddy instance |
| Jitsi Videobridge | `meet.hades.ws` | UDP 10000 directly to JVB |

Jitsi must have its own origin; do not mount it below `relay.hades.ws/meet`. Keep the
Jitsi services as a separately supervised Compose project so restarting Relay cannot
terminate an active meeting. Use a pinned stable release of the official
`docker-jitsi-meet` package rather than copying its service definitions into Relay.

## Host provisioning

These steps require the eventual public host and are intentionally not automated in
this repository yet:

1. Point both DNS names at the host's public address.
2. Issue a trusted certificate whose SANs include both names (or configure Caddy to
   obtain separate certificates).
3. Allow TCP 443 and UDP 10000 through the host and provider firewalls. If the host is
   behind NAT, forward UDP 10000 and set Jitsi's `JVB_ADVERTISE_IPS` to the public IP.
4. Download a stable release from the official `docker-jitsi-meet` project, generate
   its required passwords, and configure `PUBLIC_URL=https://meet.hades.ws`.
5. Connect its `web` service to Relay's `edge` network with the alias `jitsi-web`.
   Do not connect Prosody, Jicofo, or JVB to Relay's `backend` network.
6. Add the site block in [`Caddyfile.site`](Caddyfile.site) to `ops/Caddyfile`, mount a
   certificate covering `meet.hades.ws`, and reload Caddy.
7. Configure Relay and replace only its web service:

   ```dotenv
   RELAY_JITSI_BASE_URL=https://meet.hades.ws
   RELAY_JITSI_EMBED_ENABLED=true
   ```

   ```sh
   ops/deploy.sh web
   ```

Verify a call with at least three participants on different networks. A two-person
test does not prove that the Videobridge advertised address and UDP ingress work.

The first deployment may use Relay's opaque, random room names. Before inviting
untrusted users, require Jitsi JWT authentication and have Relay mint short-lived,
room-scoped tokens; that is a separate security boundary and is not implemented yet.

Official references: [Docker deployment](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker/),
[iframe API](https://jitsi.github.io/handbook/docs/dev-guide/dev-guide-iframe/), and
[token authentication](https://jitsi.github.io/handbook/docs/devops-guide/token-authentication/).
