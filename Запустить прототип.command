#!/bin/zsh
set -e
cd -- "$(dirname -- "$0")"
PORTAL_NODE="$(command -v node || true)"
if [[ -z "$PORTAL_NODE" || ! -x "$PORTAL_NODE" ]]; then
  print 'Установите Node.js 24, затем в папке проекта выполните npm ci и npm run demo.'
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
if ! "$PORTAL_NODE" -e 'process.exit(Number(process.versions.node.split(".")[0]) === 24 ? 0 : 1)'; then
  print 'Для прототипа нужен Node.js 24. Переключите версию Node.js и повторите запуск.'
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
if [[ ! -d node_modules ]]; then
  print 'Сначала установите зависимости: npm ci'
  read -r '?Нажмите Enter, чтобы закрыть окно.'
  exit 1
fi
print 'Сайт откроется по адресу http://localhost:3000'
print 'Доступы: .local/demo-access.txt. Для остановки нажмите Ctrl+C.'
exec "$PORTAL_NODE" scripts/local-demo.js
