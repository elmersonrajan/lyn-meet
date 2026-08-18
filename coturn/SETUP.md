# coturn on your existing server

Install on the **same machine** that runs the Node backend.

```bash
# Debian / Ubuntu
sudo apt update
sudo apt install coturn -y

sudo cp turnserver.conf.example /etc/turnserver.conf
# edit YOUR_PUBLIC_IP and the password

sudo sed -i 's/#TURNSERVER_ENABLED=1/TURNSERVER_ENABLED=1/' /etc/default/coturn
sudo systemctl enable coturn
sudo systemctl restart coturn
```

Open firewall:

- `3478/udp` `3478/tcp` (STUN/TURN)
- `5349/tcp` (TURNS if you add TLS certs)
- `49152-65535/udp` (relay)
- `40000-49999/udp+tcp` (mediasoup RTC)
- `5000/tcp` (API + Socket.IO)
- `5173/tcp` (Vite dev) or `80/443` in production

Match `backend/.env`:

```
PUBLIC_IP=YOUR_PUBLIC_IP
MEDIASOUP_ANNOUNCED_IP=YOUR_PUBLIC_IP
TURN_ENABLED=true
TURN_URLS=turn:YOUR_PUBLIC_IP:3478?transport=udp,turn:YOUR_PUBLIC_IP:3478?transport=tcp
TURN_USERNAME=classroom
TURN_CREDENTIAL=change-this-turn-secret
STUN_URLS=stun:YOUR_PUBLIC_IP:3478,stun:stun.l.google.com:19302
```
