title="Hello from bash $BASH_VERSION"
files=(*)
{
  printf '<!doctype html>\n<html lang="en">\n  <head>\n'
  printf '    <meta charset="utf-8" />\n'
  printf '    <meta name="viewport" content="width=device-width, initial-scale=1" />\n'
  printf '    <title>%s</title>\n' "$title"
  printf '    <style>\n      @view-transition {\n        navigation: auto;\n      }\n    </style>\n'
  printf '    <link rel="stylesheet" href="os.css" />\n'
  printf '  </head>\n  <body>\n    <main>\n'
  printf '      <h1 class="brand">SLICC</h1>\n'
  printf '      <p id="shell">%s</p>\n' "$title"
  printf '      <p id="written">Written by boot.sh in the shared worker at %(%Y-%m-%d %H:%M:%S)T</p>\n' -1
  printf '      <h2>os/ as bash saw it</h2>\n      <ul id="seen">\n'
  printf '        <li>%s</li>\n' "${files[@]}"
  printf '      </ul>\n'
  printf '      <p><a href="./">Open the SLICC UI</a></p>\n'
  printf '    </main>\n  </body>\n</html>\n'
} > bash.html
echo "wrote os/bash.html after seeing ${#files[@]} files in os/"
