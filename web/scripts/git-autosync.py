#!/usr/bin/env python3
"""Auto-sync del repo Tito Metralleta → GitHub, casi en tiempo real.

Vigila el repo con poll + debounce y hace commit (y push, si hay remoto
escribible) en cuanto los cambios se estabilizan. Corre bajo un LaunchAgent
con KeepAlive.

Autónomo a propósito: NO importa nada del motor de forex. Este repo es otro
proyecto y no debe acoplarse al de Koenig & Bauer.

Cuatro decisiones tomadas del watcher de forex, que costaron dos días de sync
perdido allí y aquí vienen de fábrica:

  1. **Un pull fallido NO bloquea el commit.** Aquel bug dejó commits locales
     para siempre con el proceso figurando sano. Aquí el commit va primero y el
     push es best-effort.
  2. **El push se reintenta aunque no haya cambios nuevos.** Si el push falla y
     nadie vuelve a tocar un archivo, sin esto no reintentaría jamás.
  3. **Sin remoto escribible, sigue commiteando en local.** Es el caso de hoy:
     el repo es de Víctor y Angel no tiene permiso de escritura. Versionar en
     local ya protege el trabajo; el push se activará solo cuando exista un
     remoto propio.
  4. **Blindaje de secretos**: nunca añade un archivo nuevo con pinta de
     credencial, aunque .gitignore no lo cubra. Un .gitignore incompleto no
     puede ser lo único que separe una API key de GitHub.
"""
import os
import re
import subprocess
import sys
import time

REPO = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

INTERVALO = 20          # cada cuánto se mira el repo, en segundos
DEBOUNCE = 25           # hay que estar quieto este rato antes de commitear
REINTENTO_PUSH = 300    # si el push falló, se reintenta cada 5 min

# Nombres que NUNCA se añaden, cubra o no el .gitignore.
SOSPECHOSO = re.compile(
    r"(^|/)\.env|token|secret|credential|password|\.pem$|\.key$|id_rsa|id_ed25519",
    re.IGNORECASE,
)


def git(*args, **kw):
    return subprocess.run(
        ["git", "-C", REPO, *args],
        capture_output=True, text=True, timeout=kw.get("timeout", 120),
    )


def hay_operacion_en_curso() -> bool:
    """No commitear en medio de un merge/rebase: se destruiría el estado."""
    d = os.path.join(REPO, ".git")
    return any(
        os.path.exists(os.path.join(d, x))
        for x in ("MERGE_HEAD", "REBASE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD")
    )


def limpiar_locks():
    """Un git muerto deja index.lock y traba a todos los siguientes."""
    lock = os.path.join(REPO, ".git", "index.lock")
    try:
        if os.path.exists(lock) and time.time() - os.path.getmtime(lock) > 300:
            os.remove(lock)
            print("[autosync] index.lock huérfano eliminado", flush=True)
    except OSError:
        pass


def cambios() -> str:
    r = git("status", "--porcelain")
    return r.stdout if r.returncode == 0 else ""


def sospechosos(porcelain: str) -> list[str]:
    """Archivos NUEVOS (no rastreados) con pinta de secreto."""
    fuera = []
    for linea in porcelain.splitlines():
        if not linea.startswith("??"):
            continue
        ruta = linea[3:].strip().strip('"')
        if SOSPECHOSO.search(ruta):
            fuera.append(ruta)
    return fuera


def commitear() -> bool:
    porcelain = cambios()
    if not porcelain.strip():
        return False

    peligro = sospechosos(porcelain)
    if peligro:
        # Se aborta ENTERO, no se filtra: si algo huele a secreto, que lo mire
        # un humano. Callarse y subir el resto sería lo peor de ambos mundos.
        print(f"[autosync] ABORTADO: archivos sospechosos sin ignorar: {peligro}", flush=True)
        return False

    if hay_operacion_en_curso():
        print("[autosync] merge/rebase en curso, no toco nada", flush=True)
        return False

    git("add", "-A")
    sello = time.strftime("%Y-%m-%d %H:%M:%S")
    r = git("commit", "-m", f"auto-sync: {sello}")
    if r.returncode == 0:
        print(f"[autosync] commit: {sello}", flush=True)
        return True
    if "nothing to commit" not in (r.stdout + r.stderr):
        print(f"[autosync] commit falló: {(r.stdout + r.stderr)[:200]}", flush=True)
    return False


def hay_pendientes() -> bool:
    """¿Commits locales que el remoto no tiene?"""
    r = git("rev-list", "--count", "@{u}..HEAD")
    if r.returncode != 0:
        return False  # sin upstream configurado
    try:
        return int(r.stdout.strip()) > 0
    except ValueError:
        return False


def empujar() -> bool:
    r = git("push", timeout=180)
    if r.returncode == 0:
        print("[autosync] push OK", flush=True)
        return True
    err = (r.stdout + r.stderr)
    if "denied" in err or "Permission" in err:
        # Caso conocido: el remoto es de otro y no hay permiso. No es un fallo
        # que reintentar en bucle ruidoso — se avisa una vez por ciclo largo.
        print("[autosync] sin permiso de push; el trabajo queda versionado en local", flush=True)
        return False
    if "rejected" in err or "non-fast-forward" in err:
        print("[autosync] remoto divergente, intentando rebase…", flush=True)
        if git("pull", "--rebase", timeout=180).returncode == 0:
            return git("push", timeout=180).returncode == 0
    print(f"[autosync] push falló: {err[:200]}", flush=True)
    return False


def main() -> int:
    print(f"[autosync] vigilando {REPO}", flush=True)
    ultimo_cambio = 0.0
    firma_previa = ""
    ultimo_intento_push = 0.0

    while True:
        try:
            limpiar_locks()
            firma = cambios()

            if firma != firma_previa:
                firma_previa = firma
                ultimo_cambio = time.time()

            estable = firma.strip() and (time.time() - ultimo_cambio) >= DEBOUNCE
            if estable and commitear():
                firma_previa = ""

            # El push se reintenta por su cuenta: sin esto, un push fallido no
            # se recupera nunca si Angel deja de tocar archivos.
            if hay_pendientes() and (time.time() - ultimo_intento_push) >= REINTENTO_PUSH:
                ultimo_intento_push = time.time()
                empujar()

        except Exception as exc:  # noqa: BLE001 - el watcher NUNCA debe morir
            print(f"[autosync] error no fatal: {exc}", flush=True)

        time.sleep(INTERVALO)


if __name__ == "__main__":
    sys.exit(main())
