#!/usr/bin/env bash
# 生成本地开发证书：根证书 + 覆盖 localhost 与局域网 IP 的服务端证书。
# 根证书需要装到访问的设备上（macOS 钥匙串 / iPhone 描述文件），否则浏览器仍会拦麦克风。
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
dir="$root/certs"
mkdir -p "$dir"

lan_ip="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
[ -z "$lan_ip" ] && lan_ip="127.0.0.1"

if [ ! -f "$dir/rootCA.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -sha256 -days 3650 -nodes \
    -keyout "$dir/rootCA.key" -out "$dir/rootCA.crt" \
    -subj "/CN=companion-bot local CA" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  echo "已生成根证书: $dir/rootCA.crt"
fi

cat > "$dir/server.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,IP:127.0.0.1,IP:$lan_ip
EOF

openssl req -newkey rsa:2048 -sha256 -nodes \
  -keyout "$dir/dev.key" -out "$dir/dev.csr" \
  -subj "/CN=companion-bot dev" >/dev/null 2>&1

openssl x509 -req -in "$dir/dev.csr" \
  -CA "$dir/rootCA.crt" -CAkey "$dir/rootCA.key" -CAcreateserial \
  -out "$dir/dev.crt" -days 825 -sha256 -extfile "$dir/server.ext" >/dev/null 2>&1

rm -f "$dir/dev.csr" "$dir/server.ext"

echo "证书已生成（含 IP ${lan_ip}）:"
echo "  服务端证书: $dir/dev.crt"
echo "  根证书:     $dir/rootCA.crt"
echo ""
echo "下一步："
echo "  macOS: security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db \"$dir/rootCA.crt\""
echo "  iPhone: 用 AirDrop 或起个 http 服务把 rootCA.crt 传给手机安装，再到「设置 → 通用 → 关于本机 → 证书信任设置」开启完全信任"
echo "  http 传输可用: cd \"$dir\" && python3 -m http.server 8000"
echo ""
echo "然后直接 pnpm dev，Vite 会自动改用这套证书：https://${lan_ip}:5173"
