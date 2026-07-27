#!/usr/bin/env python3
"""Lanzador de sync-watchlist.sh bajo launchd.

Existe por un motivo concreto y poco obvio: **launchd no puede leer archivos de
~/Desktop con `/bin/bash`**. El TCC de macOS concede el acceso por binario, y
/bin/bash no lo tiene. El job moría con `exit 126` y este error en el log:

    /bin/bash: .../sync-watchlist.sh: Operation not permitted
    shell-init: error retrieving current directory: getcwd: ...

A mano funciona —la terminal de Angel sí tiene permiso— así que el fallo solo
se ve mirando el estado del job, no ejecutándolo uno mismo.

La solución: este intérprete de uv SÍ tiene Acceso a Disco Completo, así que
lee el guion y se lo pasa a bash **por STDIN**. Bash nunca abre una ruta del
Desktop, así que su falta de permiso deja de importar.

Como por STDIN `BASH_SOURCE` viene vacío, la raíz del proyecto se pasa en
`TITO_WEB_DIR` (el guion ya la acepta).
"""
import os
import subprocess
import sys

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GUION = os.path.join(WEB, "scripts", "sync-watchlist.sh")


def main() -> int:
    try:
        with open(GUION, "r", encoding="utf-8") as fh:
            codigo = fh.read()
    except OSError as exc:
        print(f"[sync] no se pudo leer {GUION}: {exc}", file=sys.stderr)
        return 1

    entorno = {**os.environ, "TITO_WEB_DIR": WEB}
    # `bash -s` ejecuta lo que llegue por stdin. El cwd se fija aquí, no en el
    # plist: launchd tampoco podía hacer chdir al Desktop.
    try:
        r = subprocess.run(
            ["/bin/bash", "-s"],
            input=codigo,
            text=True,
            cwd=WEB,
            env=entorno,
            timeout=600,
        )
        return r.returncode
    except subprocess.TimeoutExpired:
        print("[sync] el drenador excedió los 10 min y se abortó", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
