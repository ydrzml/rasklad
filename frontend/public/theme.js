/* Тема до первой отрисовки, чтобы страница не мигала белым. Отдельным файлом, а не в index.html:
   политика безопасности (nginx.conf) не пускает встроенные скрипты. Логика та же, что в src/ui/theme.ts */
try {
  var theme = localStorage.getItem("lct.theme");
  if (theme === "light" || theme === "dark") document.documentElement.setAttribute("data-theme", theme);
} catch (e) {
  // без хранилища тема как в системе
}
