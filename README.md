# Mariñeiro Pescador — App de estudo

App web (PWA) para preparar o exame de **Mariñeiro/a Pescador/a** en **galego**. Funciona
sen conexión e instálase no móbil. Pensada para estudar tamén mentres camiñas, con audio.

## Que inclúe

- **Practicar** — preguntas por módulo, con corrección inmediata e explicación en galego.
- **Simulacro de exame** — 30 preguntas, 50 minutos, criterio real de APTO (20+ acertos,
  máximo 5 fallos no Módulo 2). Inclúe os exames reais de Xuño 2018 e Marzo 2018.
- **Nós mariñeiros** — diagramas paso a paso, descrición e uso, e un test para identificalos.
  Marca os 5 nós esixidos: *As de guía, Nó chairo, Dobre/Lasca, Ballestrinque, Pescador*.
- **Repasar fallos** — recupera as preguntas que máis fallas.
- **Audio (mans libres)** — le as preguntas e respostas en voz alta para estudar camiñando.
- **Galego / Castelán** — alterna o idioma de cada pregunta co botón GL/ES.

Todo o contido vive en `data/questions.json` e `data/knots.json`. A app é estática: unha vez
cargada, estudar non consome datos nin tokens.

## Probar en local

```bash
python3 -m http.server 8000
# abre http://localhost:8000
```

## Publicar (GitHub Pages)

Hai un workflow en `.github/workflows/pages.yml` que despraza a app automaticamente.
Para activalo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
Tras o seguinte push, a app estará en `https://<usuario>.github.io/<repo>/`.

## Estrutura

```
index.html            página principal
css/style.css         estilos
js/app.js             lóxica (router, quiz, exame, nós, audio)
data/questions.json   banco de 60 preguntas (bilingüe gl/es)
data/knots.json       10 nós con pasos e uso
assets/knots/*.png    diagramas dos nós
sw.js                 service worker (uso sen conexión)
manifest.webmanifest  metadatos PWA
materials/            materiais de orixe (PDFs, capturas)
```

## Engadir máis preguntas

Edita `data/questions.json` seguindo o mesmo esquema (campos `q_gl`, `q_es`, `options_gl`,
`options_es`, `answer` 0–3, `module`, `explanation_gl`). Lembra subir a versión da caché
(`CACHE`) en `sw.js` para que os dispositivos collan os cambios.
