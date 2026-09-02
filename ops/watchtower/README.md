# Shared Watchtower stack

This stack runs one Watchtower instance for Umbrel Portainer's nested Docker daemon.
The socket is shared by every stack inside that Portainer environment, so Watchtower
can update opted-in containers from any Portainer stack; it does not need to live
beside the application it updates. It cannot see or update native Umbrel App Store
containers, which run in Umbrel's outer Docker daemon.

It uses the maintained `nickfedor/watchtower` fork. The original
`containrrr/watchtower` repository was archived in December 2025. The fork retains
the existing `com.centurylinklabs.watchtower.*` labels, so application-stack labels do
not need to be renamed.

Deploy [`compose.yaml`](compose.yaml) as its own Portainer stack. Add this label only
to services whose normal upgrade is a simple container replacement:

```yaml
labels:
  com.centurylinklabs.watchtower.enable: "true"
```

Before moving the existing instance, copy across any registry-credential mount,
notification variables, schedule, or scope that it currently uses. The supplied
stack intentionally contains none of those site-specific values. Mounting
`/var/run/docker.sock` gives this container control of every container in the nested
Portainer environment, so keep the stack restricted to administrators.

Then remove the old Watchtower service from its current stack. Do this in that order
so there is no monitoring gap, and confirm the standalone container is healthy before
removing the old one. Never run two unscoped Watchtower instances against the same
containers.

Relay is deliberately labelled `com.centurylinklabs.watchtower.enable=false`.
Its worker must drain and its database must be backed up and migrated in a defined
order, which Watchtower cannot enforce. Use Relay's deployment procedure instead.
