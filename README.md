# Bounty Radar

Site que monitora bounties web3 abertos no **Superteam Earn** e **First Dollar**, atualizado automaticamente a cada 6 horas via GitHub Actions.

- `index.html` — o site em si (HTML/CSS/JS puro, sem build).
- `data.json` — os bounties atuais. É reescrito automaticamente pelo GitHub Action; não precisa editar à mão.
- `scripts/update-data.mjs` — script Node que busca os bounties novos e atualiza o `data.json`.
- `.github/workflows/update.yml` — o agendamento (cron) que roda o script a cada 6h.

Veja `COMO-PUBLICAR.md` para o passo a passo de como colocar isso no ar de graça pelo GitHub Pages.
