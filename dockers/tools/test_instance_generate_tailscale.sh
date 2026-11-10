./generate_tailscale_serve.sh \
  --host deepseek-harness \
  --map 4080:4080 \
  --map 4300-4399:3300-3399 \
  -o ../tailscale-serve.json