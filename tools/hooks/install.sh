#!/bin/sh
# Ставит хук pre-commit со сканом секретов: npm run hooks.
# Хук — маленькая обёртка, которая зовёт tools/hooks/pre-commit из рабочего дерева, поэтому правки скана
# действуют сразу. Чужой pre-commit не перезаписывается. Ворота всё равно `npm test`: хук можно и не ставить.
set -eu
top=$(git rev-parse --show-toplevel)
hooks=$(git rev-parse --git-path hooks)
case "$hooks" in /*) ;; *) hooks="$top/$hooks" ;; esac
mkdir -p "$hooks"
target="$hooks/pre-commit"
mark='# meatsuit: secret-scan'
if [ -e "$target" ] && ! grep -q "$mark" "$target"; then
  echo "hooks: $target уже есть и он не наш; не трогаю. Добавьте в него строку:" >&2
  echo "  sh \"\$(git rev-parse --show-toplevel)/tools/hooks/pre-commit\"" >&2
  exit 1
fi
cat > "$target" <<'HOOK'
#!/bin/sh
# meatsuit: secret-scan (поставил npm run hooks; убрать — удалить этот файл)
exec sh "$(git rev-parse --show-toplevel)/tools/hooks/pre-commit"
HOOK
chmod +x "$target"
echo "hooks: pre-commit поставлен ($target)"
