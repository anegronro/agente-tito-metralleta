#!/usr/bin/env python3
"""Renueva el access token de Schwab y lo empuja al VPS por Tailscale.

POR QUÉ EXISTE: el refresh token de Schwab **rota** al usarse. Si el Mac y el
VPS renovaran cada uno por su cuenta, el segundo invalidaría el token del
primero y la sesión moriría en un sitio u otro sin explicación. Así que hay un
único DUEÑO —esta Mac— y el VPS es un SEGUIDOR que solo lee
(`SCHWAB_ROLE=follower` en lib/schwab.ts).

Lo que viaja al VPS es **solo el access token**, que dura ~30 min. El refresh
token NUNCA sale de aquí: aunque alguien entrara al VPS, no podría renovar nada
ni mantener el acceso más allá de esa media hora.

Corre bajo launchd cada 15 min (com.tito.schwab-push). El access dura 30, así
que hay un pase de margen si uno falla.
"""
# El python del sistema en esta Mac es 3.9 y no acepta `str | None` en las
# anotaciones. Bajo launchd corre con el 3.12 de uv, pero conviene que también
# se pueda lanzar a mano.
from __future__ import annotations

import base64
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

WEB = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_FILE = os.path.join(WEB, ".env.local")
TOKEN_FILE = os.path.join(WEB, "data", "schwab-tokens.json")

VPS = os.environ.get("TITO_VPS", "root@100.105.244.125")
# El bundle standalone deja server.js en /root/tito, y systemd fija ahí el
# WorkingDirectory, así que `process.cwd()/data` resuelve a /root/tito/data.
DESTINO = "/root/tito/data/schwab-tokens.json"
TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token"


def env_var(nombre: str) -> str | None:
    try:
        with open(ENV_FILE, encoding="utf-8") as fh:
            for linea in fh:
                t = linea.strip()
                if not t or t.startswith("#"):
                    continue
                eq = t.find("=")
                if eq > 0 and t[:eq].strip() == nombre:
                    return t[eq + 1:].strip()
    except OSError:
        return None
    return None


def log(msg: str) -> None:
    print(f"[schwab-push] {datetime.now().isoformat(timespec='seconds')} {msg}", flush=True)


def main() -> int:
    key, secret = env_var("SCHWAB_APP_KEY"), env_var("SCHWAB_APP_SECRET")
    if not key or not secret:
        log("faltan SCHWAB_APP_KEY / SCHWAB_APP_SECRET en .env.local")
        return 1

    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            guardado = json.load(fh)
    except (OSError, json.JSONDecodeError) as exc:
        log(f"no se pudo leer el token local: {exc}")
        return 1

    refresh = guardado.get("refresh_token")
    if not refresh:
        log("sin refresh_token: corre `node scripts/schwab-auth.mjs`")
        return 1

    datos = urllib.parse.urlencode(
        {"grant_type": "refresh_token", "refresh_token": refresh}
    ).encode()
    pet = urllib.request.Request(
        TOKEN_URL,
        data=datos,
        headers={
            "Authorization": "Basic "
            + base64.b64encode(f"{key}:{secret}".encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded",
        },
    )
    try:
        with urllib.request.urlopen(pet, timeout=30) as r:
            tok = json.loads(r.read())
    except urllib.error.HTTPError as exc:
        log(f"Schwab rechazó la renovación (HTTP {exc.code}). "
            "Puede que el refresh haya caducado: `node scripts/schwab-auth.mjs`")
        return 1
    except Exception as exc:  # noqa: BLE001 - red
        log(f"error de red al renovar: {exc}")
        return 1

    acceso = tok.get("access_token")
    if not acceso:
        log("la respuesta no trae access_token")
        return 1

    ahora = datetime.now(timezone.utc).isoformat()
    expira = tok.get("expires_in", 1800)

    # Si Schwab rotó el refresh, se guarda AQUÍ (el dueño). Perderlo mataría
    # la sesión en cuanto caduque el viejo.
    nuevo_refresh = tok.get("refresh_token")
    if nuevo_refresh and nuevo_refresh != refresh:
        guardado["refresh_token"] = nuevo_refresh
        log("Schwab rotó el refresh token; guardado")
    guardado.update(access_token=acceso, obtained_at=ahora, expires_in=expira)
    with open(TOKEN_FILE, "w", encoding="utf-8") as fh:
        json.dump(guardado, fh, indent=2)
    os.chmod(TOKEN_FILE, 0o600)

    # Copia para el VPS: SIN refresh token, a propósito.
    copia = {"access_token": acceso, "obtained_at": ahora, "expires_in": expira}
    tmp = TOKEN_FILE + ".vps"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(copia, fh, indent=2)
    os.chmod(tmp, 0o600)

    try:
        r = subprocess.run(
            ["scp", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10", tmp, f"{VPS}:{DESTINO}"],
            capture_output=True, text=True, timeout=60,
        )
        if r.returncode != 0:
            log(f"scp falló: {(r.stdout + r.stderr).strip()[:200]}")
            return 1
    except Exception as exc:  # noqa: BLE001
        log(f"scp no pudo ejecutarse: {exc}")
        return 1
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass

    log(f"access token renovado y empujado (vence en {expira}s)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
