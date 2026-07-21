#!/bin/bash
# Запуск LoRA Steps Calculator (macOS)
cd "$(dirname "$0")" || exit 1

if ! command -v npm >/dev/null 2>&1; then
  echo "❌ Не найден npm. Установите Node.js: https://nodejs.org (или: brew install node)"
  read -r -p "Нажмите Enter для выхода..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo "⏳ Первый запуск: устанавливаю зависимости (Electron)..."
  npm install || { echo "❌ Ошибка установки зависимостей"; read -r -p "Enter для выхода..."; exit 1; }
fi

echo "🚀 Запускаю LoRA Steps Calculator..."
exec npm start
