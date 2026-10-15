# PM2 Captain service setup guide

In this example, we'll use PM2 (of course) and [Nginx](https://nginx.org/) as a reverse proxy.

## Guided setup

Run the installer:

```bash
curl -fsSL https://raw.githubusercontent.com/panta82/pm2-captain/refs/heads/master/install.sh |
  bash
```

The installer will ask you for the installation location and a few configuration options. It will then generate a `ecosystem.config.cjs` file, which you can use to add Captain to your local PM2.

For unattended setup, pass explicit options to Bash:

```bash
curl -fsSL https://raw.githubusercontent.com/panta82/pm2-captain/refs/heads/master/install.sh |
  bash -s -- \
    --yes \
    --dir /opt/pm2-captain \
    --name pm2-captain \
    --port 3212 \
    --auth proxy
```

## Manual setup

Create a dedicated installation and pin Captain:

```bash
mkdir -p ~/opt/pm2-captain
cd ~/opt/pm2-captain
npm init -y
npm install --save-exact pm2-captain@1
```

Create `ecosystem.config.cjs`:

```js
module.exports = {
  apps: [
    {
      name: 'pm2-captain',
      cwd: __dirname,
      script: require.resolve('pm2-captain'),
      args: ['--no-open', '--port', '3212', '--no-auth'],
      autorestart: true,
      stop_exit_codes: [78],
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
```

## Either approach

Start the ecosystem and save the process list:

```bash
pm2 start ecosystem.config.cjs --only pm2-captain
pm2 save
```

Captain continues to listen only on `127.0.0.1`. The `--no-auth` option
delegates authentication to the reverse proxy, so the proxy must protect the
service.

The following Nginx server block terminates HTTPS, requires HTTP Basic
Authentication, and forwards regular and WebSocket traffic to Captain:

```nginx
server {
    listen 443 ssl;
    server_name captain.example.com;

    ssl_certificate /etc/letsencrypt/live/captain.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/captain.example.com/privkey.pem;

    auth_basic "PM2 Captain";
    auth_basic_user_file /etc/nginx/.pm2-captain.htpasswd;

    location / {
        proxy_pass http://127.0.0.1:3212;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";

        proxy_buffering off;
    }
}
```

For example, create the password file with `htpasswd` (provided by
`apache2-utils` on Debian and Ubuntu), then validate, and reload Nginx:

```bash
sudo htpasswd -c /etc/nginx/.pm2-captain.htpasswd captain
sudo nginx -t
sudo systemctl reload nginx
```

If the selected port already hosts Captain, a new `ssh` or `--pm2-home`
invocation adds the requested daemon to that running instance, then opens, or
prints its URL. An invocation without a daemon simply opens or prints the
existing instance. If
another application owns the port, Captain exits with code `78`. The
`stop_exit_codes` setting prevents PM2 from repeatedly restarting a
misconfigured instance while preserving normal autorestart behavior for other
failures.
