set -euo pipefail
umask 077
work=$(mktemp -d "${RUNNER_TEMP:?}/lease-interop.XXXXXXXX")
pins=test/integration/lease-interop/pins.json
broker=$(jq -er '.broker | select(.repo == "ai-ecoverse/slicc-cli").commit | select(test("^[0-9a-f]{40}$"))' "$pins")
tag=$(jq -er '.broker.tag | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' "$pins")
signer=$(jq -er '.broker.signer | select(startswith("https://github.com/ai-ecoverse/slicc-shared-web/.github/workflows/pipeline.yml@refs/tags/"))' "$pins")
site=$(jq -er '.site | select(.repo == "ai-ecoverse/slicc-browsers").commit | select(test("^[0-9a-f]{40}$"))' "$pins")
fetch() {
  local src=$1 digest=$2 file=$3
  [[ $digest =~ ^[0-9a-f]{64}$ ]]
  curl -qfsSL --proto '=https' --proto-redir '=https' --max-redirs 4 --max-time 120 -o "$file" "$src"
  printf '%s  %s\n' "$digest" "$file" | sha256sum --check --status -
}
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]]
asset=slicc-linux-amd64
release=https://github.com/ai-ecoverse/slicc-cli/releases/download/$tag
for name in SHA256SUMS SHA256SUMS.sigstore.json "$asset"; do
  fetch "$release/$name" "$(jq -er --arg n "$name" '.broker.files[$n]' "$pins")" "$work/$name"
done
mkdir -m 700 "$work/home"
env -i PATH="$PATH" HOME="$work/home" GH_PROMPT_DISABLED=1 gh attestation verify "$work/SHA256SUMS" \
  --repo ai-ecoverse/slicc-cli --bundle "$work/SHA256SUMS.sigstore.json" \
  --source-ref refs/heads/main --source-digest "$broker" --cert-identity "$signer" \
  --cert-oidc-issuer https://token.actions.githubusercontent.com \
  --predicate-type https://slsa.dev/provenance/v1 --deny-self-hosted-runners
checksum=$(awk -v name="$asset" '$2 == name { sum=$1; n++ } END { if (n != 1) exit 1; print sum }' "$work/SHA256SUMS")
[[ $checksum =~ ^[0-9a-f]{64}$ ]]
printf '%s  %s\n' "$checksum" "$work/$asset" | sha256sum --check --status -
chmod 700 "$work/$asset"
for name in lease-page.mjs lease-square.woff; do
  fetch "https://raw.githubusercontent.com/ai-ecoverse/slicc-browsers/$site/test/integration/fixtures/$name" "$(jq -er --arg n "$name" '.site.files[$n]' "$pins")" "$work/$name"
done
printf 'verified broker release %s; source %s; signed SHA-256 %s; site source %s; BIOS tree %s\n' "$tag" "$broker" "$checksum" "$site" "$(git rev-parse HEAD)"
printf 'SLICC_LEASE_BROKER=%s\nSLICC_LEASE_PAGE_FIXTURE=%s\n' "$work/$asset" "$work/lease-page.mjs" >> "${GITHUB_ENV:?}"
