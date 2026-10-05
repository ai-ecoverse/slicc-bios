emit() {
  while IFS= read -r line; do printf '%s\n' "$line"; done
}

title="Hello from bash $BASH_VERSION"
printf -v stamp '%(%Y-%m-%d %H:%M:%S)T' -1
files=(*)

{
  emit <<HTML
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>$title</title>
    <style>
      @view-transition {
        navigation: auto;
      }
    </style>
    <link rel="stylesheet" href="os.css" />
  </head>
  <body>
    <main>
      <h1 class="brand">SLICC</h1>
      <p id="shell">$title</p>
      <p id="written">Written by boot.sh in the shared worker at $stamp</p>
      <p id="kernel">Connecting to the kernel…</p>
      <h2>os/ as bash saw it</h2>
      <ul id="seen">
HTML
  printf '        <li>%s</li>\n' "${files[@]}"
  emit <<'HTML'
      </ul>
      <p><a href="./">Open the SLICC UI</a></p>
    </main>
    <script type="module">
      import { kernel } from './connect.js';
      const { connections } = await kernel('hello');
      const status = `Connected to the kernel (connection ${connections})`;
      document.getElementById('kernel').textContent = status;
    </script>
  </body>
</html>
HTML
} > bash.html
echo "wrote os/bash.html after seeing ${#files[@]} files in os/"
