# PBX setup prerequisites

Target: **3CX V20 Update 10**, as specified by the user. No installed PBX has been accessed or verified.

1. Record the exact installed build and confirm Call Control access for the licence.
2. In Admin → Integrations → API, create a least-privilege Service Principal with Call Control access. Its Client ID is the internally dialled programmable extension identifier.
3. Record the PBX HTTPS origin and allowed extensions. Enter the secret only through the application Connections page on a dedicated test installation.
4. Approve one technician queue/extension and the supported fallback route. Do not allow arbitrary model-supplied destinations.
5. After Phase 2 hooks and readiness checks are implemented, dial the Client ID internally and prove audio, interruptions, call cleanup and transfer.
6. Only after internal validation should an IVR option or DID route be enabled for a staff pilot.

The untouched upstream reference reads plaintext YAML and logs transcripts; it must not be run with real clinic data as part of this foundation. See the [official guide](https://www.3cx.com/docs/programmable-extensions/) for provisioning details; verify them against the installed build.
