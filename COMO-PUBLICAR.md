# Como colocar o Bounty Radar no ar de graça (GitHub Pages)

Isso aqui vai te dar um site público, com link próprio, que se atualiza sozinho a cada 6 horas — sem custar nada e sem você precisar mexer em nada depois de configurado.

## Passo 1 — Criar o repositório

1. Entre no GitHub e clique no **+** no canto superior direito → **New repository**.
2. Dê um nome, por exemplo `bounty-radar`.
3. Deixe marcado como **Public** (precisa ser público pro GitHub Pages funcionar de graça).
4. Não marque nenhuma opção de "adicionar README" — deixe o repositório vazio.
5. Clique em **Create repository**.

## Passo 2 — Subir os arquivos

Você vai receber uma pasta com estes arquivos/pastas:

```
index.html
data.json
README.md
COMO-PUBLICAR.md
.github/workflows/update.yml
scripts/update-data.mjs
```

Na página do repositório recém-criado, clique em **"uploading an existing file"** (ou vá em **Add file → Upload files**).

Arraste **a pasta inteira** (ou todos os arquivos e subpastas) para a área de upload. O GitHub consegue reconhecer a estrutura de pastas quando você arrasta a pasta toda pelo navegador — ele preserva o caminho `.github/workflows/update.yml` e `scripts/update-data.mjs` automaticamente.

Se o navegador não aceitar arrastar a pasta (alguns navegadores só aceitam arquivos soltos), aí você cria os arquivos que estão em subpastas manualmente:
1. Clique em **Add file → Create new file**.
2. No campo de nome, digite o caminho completo: `.github/workflows/update.yml` (o GitHub cria as pastas sozinho ao ver as barras `/`).
3. Cole o conteúdo do arquivo `update.yml`.
4. Repita para `scripts/update-data.mjs`.
5. Depois arraste `index.html`, `data.json`, `README.md` direto pela raiz.

No final, clique em **Commit changes**.

## Passo 3 — Ativar o GitHub Pages

1. No repositório, vá em **Settings** (aba no topo).
2. No menu lateral, clique em **Pages**.
3. Em **Build and deployment → Source**, escolha **Deploy from a branch**.
4. Em **Branch**, escolha `main` e a pasta `/ (root)`. Clique em **Save**.
5. Espere 1–2 minutos. O GitHub vai mostrar o link do site no topo dessa mesma página, algo como:
   `https://SEU-USUARIO.github.io/bounty-radar/`

Esse é o link público e permanente do seu site. Pode compartilhar com quem quiser.

## Passo 4 — Conferir se a atualização automática está ligada

1. Vá na aba **Actions** do repositório.
2. Você deve ver um workflow chamado **"Atualizar Bounty Radar"**.
3. Se aparecer um aviso pedindo pra confirmar que quer habilitar Actions, clique em habilitar.
4. Pra testar sem esperar 6 horas: clique no workflow, depois em **Run workflow** (botão à direita) → **Run workflow** de novo pra confirmar. Em ~1 minuto ele roda, busca os bounties novos e atualiza o `data.json` automaticamente, commitando direto no repositório.

A partir daí, ele roda sozinho a cada 6 horas, sem você precisar fazer nada. O site (`index.html`) busca o `data.json` mais recente sempre que alguém abre a página.

## O que esperar

- **Superteam Earn**: busca os bounties reais direto da API pública deles — deve funcionar de forma confiável.
- **First Dollar**: não tem uma API pública, então o script tenta "adivinhar" a estrutura da página. Pode funcionar direto, ou pode precisar de um ajuste fino depois de ver os primeiros resultados reais rodando no GitHub Actions (é só me mandar o log de erro da aba Actions que eu ajudo a corrigir).
- **Nido**: continua de fora, porque as campanhas reais ficam atrás de login.

## Se quiser atualizar o site depois

Qualquer mudança visual (cores, textos, filtros) é só editar o `index.html` direto pelo GitHub (lapisinho de editar no canto do arquivo) e commitar — o site atualiza sozinho em menos de um minuto.
