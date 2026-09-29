# Если Docker Desktop не стартует

На части машин Docker Desktop падает с ошибкой про файл сокета: "rename ... sailor-ingest.sock ... The file cannot be accessed by the system". Лечится не всегда, поэтому есть запасной путь: Docker внутри WSL.

```bash
wsl --install -d Ubuntu --no-launch
wsl -d Ubuntu -u root -- bash -c "apt-get update && apt-get install -y docker.io docker-compose-v2"
```

Дальше включить systemd, чтобы служба докера не падала: записать в `/etc/wsl.conf` строки `[boot]` и `systemd=true`, выполнить `wsl --terminate Ubuntu` и запустить `systemctl enable --now docker`. После этого проект поднимается изнутри WSL:

```bash
wsl -d Ubuntu -u root -- bash -c "cd '/mnt/c/путь/до/репозитория' && docker compose up -d"
```

Порты видны из Windows как обычно: http://localhost:3000 и http://localhost:8000.
