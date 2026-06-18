echo "##### HOST #####"; hostname; uptime
echo "##### OS #####"; . /etc/os-release 2>/dev/null; echo "$PRETTY_NAME"; uname -r
echo "##### CPU/MEM #####"; echo "cores: $(nproc)"; free -h | grep Mem
echo "##### DISK #####"; df -h / | tail -1
echo "##### PUERTOS EN ESCUCHA #####"; ss -tlnp 2>/dev/null | awk 'NR==1 || /LISTEN/'
echo "##### SERVICIOS ACTIVOS #####"; systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}'
echo "##### DOCKER #####"; if command -v docker >/dev/null; then docker ps --format '{{.Names}} | {{.Image}} | {{.Status}} | {{.Ports}}' 2>/dev/null || echo "docker present, ps failed"; else echo "no docker"; fi
echo "##### PM2 #####"; if command -v pm2 >/dev/null; then pm2 jlist 2>/dev/null | tr ',' '\n' | grep -E '"name"|"status"' ; else su - ubuntu -c 'pm2 ls' 2>/dev/null || echo "no pm2"; fi
echo "##### NGINX #####"; if command -v nginx >/dev/null; then nginx -v 2>&1; echo "-- server_name --"; grep -rhE 'server_name' /etc/nginx/ 2>/dev/null | tr -s ' ' | sort -u; else echo "no nginx"; fi
echo "##### RUNTIMES #####"; node -v 2>/dev/null | sed 's/^/node /'; bun -v 2>/dev/null | sed 's/^/bun /'; python3 -V 2>/dev/null
echo "##### TOP CPU #####"; ps -eo comm,pcpu,pmem --sort=-pcpu | head -8
