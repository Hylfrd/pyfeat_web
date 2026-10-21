# PyFeat Web

FastAPI experiment web app for the PyFeat demo.

Python dependencies are pinned with hashes in `requirements.txt`. After updating
the direct versions in `requirements.in`, regenerate the cross-platform lock with:

```sh
uv pip compile requirements.in --upgrade --python-version 3.13 --universal --generate-hashes --no-header --no-annotate --output-file requirements.txt --index-url https://pypi.org/simple
```

CI audits both dependency trees and checks application compatibility before the
existing push-to-master deployment. The Windows deploy upgrades to the audited
Python lock and stops on an installation or compatibility failure.

The manually dispatched `Runtime maintenance` workflow inspects the Windows
proxy or builds and audits Caddy 2.11.7 with Go 1.27.3 and `x/net` 0.60.0 from
`scripts/caddy/go.mod` and `go.sum`. The proxy update preserves all existing
modules, validates the existing config, saves a private server backup, and
checks configured sites after switching the Caddy service. A failed switch
restores the previous binary. Config contents stay on the server.

The `update-python` operation extracts the official Python 3.13.16 NuGet package
and creates the app's environment under the private `C:\web\.runtime` directory.
It checks package hashes and Python Software Foundation signatures, installs the
Python dependency lock, and tests the app on a separate local port before
switching the private runtime selector. The previous environment remains
available for rollback. No installer, global PATH change, or launcher
registration is used.
