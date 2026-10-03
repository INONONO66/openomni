# Machine network keys (#1270)

Both ends of a network attachment pin the other's KEY, not a CA chain: the
daemon config pins the host's key fingerprint, the host pins the daemon's key
through `Enrollment.publicKey`. A fingerprint is 64 lowercase hex characters:
sha256 over the public key's SPKI DER (`Machine.fingerprintOf`; from a
certificate, `certificateKeyFingerprint` extracts the same SPKI first).
Certificates are only carriers — self-signed is the norm, expiry is ignored by
the pin check, and no CA is ever consulted.

## Generate an identity (self-signed EC P-256)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out host-key.pem
openssl req -new -x509 -key host-key.pem -out host-cert.pem -days 3650 -subj "/CN=openomni-host"
```

Repeat with `daemon-key.pem` / `daemon-cert.pem` (any CN) on the machine that
will attach.

## Derive the fingerprint to pin

```sh
openssl x509 -in host-cert.pem -pubkey -noout \
  | openssl pkey -pubin -outform DER \
  | openssl dgst -sha256 -r | cut -d' ' -f1
```

That value goes in the daemon JSON as `hostPublicKey` (for the host's cert) and
in the enrollment as `publicKey` (for the daemon's cert).

## Host exposure

Set the full tuple or none of it — a partial tuple refuses boot
(`invalid_machines_tcp`) rather than binding unencrypted:

```sh
OPENOMNI_MACHINES_TCP_HOST=0.0.0.0     # or a tailnet/LAN interface address
OPENOMNI_MACHINES_TCP_PORT=7643
OPENOMNI_MACHINES_TLS_CERT=/path/host-cert.pem
OPENOMNI_MACHINES_TLS_KEY=/path/host-key.pem
```

The unix socket stays bound regardless; same-box daemons keep zero config.

## Daemon config (`openomni machine attach <config.json>`)

```json
{
  "tcp": { "host": "100.64.0.7", "port": 7643 },
  "hostPublicKey": "<host fingerprint>",
  "tlsCertificate": "/path/daemon-cert.pem",
  "tlsPrivateKey": "/path/daemon-key.pem",
  "offer": { "machineId": "studio", "offeredCapabilities": ["fs.read"], "daemonVersion": "1", "platform": "darwin-arm64", "offeredAt": 0 }
}
```

TLS fields are PEM file paths, read at attach time. Addressing is plain TCP:
over Tailscale, put the tailnet IP (or MagicDNS name) in `tcp.host` — there is
no app-level Tailscale integration; on a LAN, the host's interface address.
Pinning makes the transport safe on any reachable network.

## Rotation

Certificates may be re-issued freely as long as the KEY inside is unchanged —
pins survive. Rotating a key is an out-of-band admission change: generate the
new identity, update the pin on the other side (enrollment `publicKey` for a
daemon key, `hostPublicKey` in every daemon JSON for the host key), then swap
the files. A stale pin refuses with `peer_key_mismatch`; nothing downgrades.

## QA recipe (ten lines)

```sh
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/hk.pem && openssl req -new -x509 -key /tmp/hk.pem -out /tmp/hc.pem -days 30 -subj "/CN=h"
openssl ecparam -name prime256v1 -genkey -noout -out /tmp/dk.pem && openssl req -new -x509 -key /tmp/dk.pem -out /tmp/dc.pem -days 30 -subj "/CN=d"
HF=$(openssl x509 -in /tmp/hc.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)
DF=$(openssl x509 -in /tmp/dc.pem -pubkey -noout | openssl pkey -pubin -outform DER | openssl dgst -sha256 -r | cut -d' ' -f1)
export OPENOMNI_MACHINES_TCP_HOST=127.0.0.1 OPENOMNI_MACHINES_TCP_PORT=7643 OPENOMNI_MACHINES_TLS_CERT=/tmp/hc.pem OPENOMNI_MACHINES_TLS_KEY=/tmp/hk.pem
export OPENOMNI_MACHINES_ENROLLED="[{\"machineId\":\"qa\",\"name\":\"qa\",\"allowedCapabilities\":[\"kernel.py\"],\"publicKey\":\"$DF\",\"enrolledAt\":0}]"
bun apps/openomni/src/cli/main.ts start &   # host side, with the rest of your env
printf '{"tcp":{"host":"127.0.0.1","port":7643},"hostPublicKey":"%s","tlsCertificate":"/tmp/dc.pem","tlsPrivateKey":"/tmp/dk.pem","offer":{"machineId":"qa","offeredCapabilities":["kernel.py"],"daemonVersion":"qa","platform":"qa","offeredAt":0}}' "$HF" > /tmp/machine.json
bun apps/openomni/src/cli/main.ts machine attach /tmp/machine.json   # prints {"status":"attached",...}
# kill the host: the daemon stays up, retrying with jittered backoff (capped 30s); restart the host and the machine serves again under the same identity
```
