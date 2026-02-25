#!/usr/bin/env node

import { readdir, stat, readFile, writeFile, mkdir, copyFile, rm } from 'fs/promises'
import path from 'path'
import { fileURLToPath } from 'url'
import esbuild from 'esbuild'
import { minify as minifyHTML } from 'html-minifier-terser'
import CleanCSS from 'clean-css'
import chokidar from 'chokidar'
import minimist from 'minimist'

const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
}

const log = {
  info: (msg) => console.log(`${colors.cyan}[INFO]${colors.reset} ${msg}`),
  success: (msg) => console.log(`${colors.green}[SUCCESS]${colors.reset} ${msg}`),
  warn: (msg) => console.warn(`${colors.yellow}[WARN]${colors.reset} ${msg}`),
  error: (msg) => console.error(`${colors.red}[ERROR]${colors.reset} ${msg}`),
  debug: (msg) => process.env.DEBUG && console.log(`${colors.dim}[DEBUG]${colors.reset} ${msg}`),
}

const DEFAULT_SRC = 'src'
const DEFAULT_DIST = 'dist'
const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.bmp', '.tiff']

function parseArgs() {
  const argv = minimist(process.argv.slice(2), {
    string: ['src', 'dist', 'external'],
    boolean: ['watch', 'clean', 'bundle', 'verbose', 'help'],
    alias: {
      s: 'src',
      d: 'dist',
      w: 'watch',
      c: 'clean',
      b: 'bundle',
      v: 'verbose',
      h: 'help',
      e: 'external',
    },
    default: {
      src: DEFAULT_SRC,
      dist: DEFAULT_DIST,
      bundle: false,
      watch: false,
      clean: false,
      verbose: false,
      external: [],
    },
  })

  if (argv.help) {
    showHelp()
    process.exit(0)
  }

  if (!Array.isArray(argv.external)) {
    argv.external = [argv.external]
  }

  if (argv.verbose) {
    process.env.DEBUG = true
  }

  return argv
}

function showHelp() {
  console.log(`
${colors.bright}Compilateur de site statique${colors.reset}

${colors.bright}Utilisation :${colors.reset}
  node compile.js --src DOSSIER_SOURCE [options]

${colors.bright}Options :${colors.reset}
  -s, --src <dossier>   Dossier source (défaut: ${DEFAULT_SRC})
  -d, --dist <dossier>  Dossier de destination (défaut: ${DEFAULT_DIST})
  -w, --watch           Surveille les changements et recompile
  -c, --clean           Nettoie le dossier dist avant de compiler
  -b, --bundle          Bundle les modules JS (attention aux dépendances manquantes)
  -e, --external <pkg>  Marque un module comme externe (peut être répété)
  -v, --verbose         Affiche des informations détaillées
  -h, --help            Affiche cette aide

${colors.bright}Exemples :${colors.reset}
  node compile.js --src mon-site
  node compile.js --src "C:/chemin avec espaces" --dist public --clean
  node compile.js --src app --bundle --external jquery --external lodash
  `)
}

async function cleanDir(dir) {
  try {
    await rm(dir, { recursive: true, force: true })
    log.info(`Dossier nettoyé : ${dir}`)
  } catch (err) {
    log.error(`Impossible de nettoyer ${dir} : ${err.message}`)
  }
}

async function processFile(file, options) {
  const relativePath = path.relative(options.src, file)
  const out = path.join(options.dist, relativePath)
  await mkdir(path.dirname(out), { recursive: true })

  const ext = path.extname(file).toLowerCase()
  log.debug(`Traitement de ${file} -> ${out}`)

  try {
    if (IMAGE_EXTENSIONS.includes(ext)) {
      await copyFile(file, out)
      log.debug(`Image copiée : ${relativePath}`)
      return
    }

    if (ext === '.js' || ext === '.mjs' || ext === '.cjs') {
      const buildOptions = {
        entryPoints: [file],
        outfile: out,
        minify: true,
        bundle: options.bundle,
        platform: 'browser',
        sourcemap: false,
        target: ['es2020'],
        external: options.external,
      }

      if (!options.bundle) {
        buildOptions.bundle = false
      }

      await esbuild.build(buildOptions)
      log.debug(`JS ${options.bundle ? 'bundlé' : 'minifié'} : ${relativePath}`)
      return
    }

    const content = await readFile(file, 'utf8')

    if (ext === '.css') {
      const minified = new CleanCSS({}).minify(content)
      if (minified.errors.length) {
        throw new Error(minified.errors.join(', '))
      }
      await writeFile(out, minified.styles)
      log.debug(`CSS minifié : ${relativePath}`)
      return
    }

    if (ext === '.html' || ext === '.htm') {
      const minified = await minifyHTML(content, {
        collapseWhitespace: true,
        removeComments: true,
        removeRedundantAttributes: true,
        removeScriptTypeAttributes: true,
        removeStyleLinkTypeAttributes: true,
        useShortDoctype: true,
        minifyCSS: true,
        minifyJS: true,
      })
      await writeFile(out, minified)
      log.debug(`HTML minifié : ${relativePath}`)
      return
    }

    await copyFile(file, out)
    log.debug(`Fichier copié : ${relativePath}`)
  } catch (err) {
    if (err.errors && err.errors.some(e => e.text.includes('Could not resolve'))) {
      log.error(`Erreur de résolution de modules dans ${relativePath}.`)
      log.info(`Si vous utilisez --bundle, vous devez soit installer les dépendances manquantes, soit les déclarer comme externes avec --external nom_du_module.`)
      log.info(`Exemple : --bundle --external jquery --external lodash`)
    }
    log.error(`Erreur sur ${file} : ${err.message}`)
    throw err
  }
}

async function walkDir(dir, options) {
  const entries = await readdir(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      await walkDir(fullPath, options)
    } else {
      await processFile(fullPath, options)
    }
  }
}

async function build(options) {
  log.info(`Compilation de ${options.src} vers ${options.dist}`)

  if (options.clean) {
    await cleanDir(options.dist)
  }

  try {
    await walkDir(options.src, options)
    log.success(`Compilation terminée avec succès.`)
  } catch (err) {
    log.error(`Échec de la compilation.`)
    process.exit(1)
  }
}

async function watch(options) {
  log.info(`Mode watch activé. Surveillance de ${options.src}`)

  if (options.clean) {
    await cleanDir(options.dist)
  }

  await walkDir(options.src, options)

  const watcher = chokidar.watch(options.src, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 100,
      pollInterval: 50,
    },
  })

  watcher
    .on('add', async (filePath) => {
      log.info(`Fichier ajouté : ${filePath}`)
      await processFile(filePath, options)
    })
    .on('change', async (filePath) => {
      log.info(`Fichier modifié : ${filePath}`)
      await processFile(filePath, options)
    })
    .on('unlink', async (filePath) => {
      const relativePath = path.relative(options.src, filePath)
      const outPath = path.join(options.dist, relativePath)
      try {
        await rm(outPath, { force: true })
        log.info(`Fichier supprimé : ${outPath}`)
      } catch (err) {
        log.error(`Erreur suppression ${outPath} : ${err.message}`)
      }
    })
    .on('error', (err) => log.error(`Erreur watcher : ${err.message}`))

  log.success(`Watch prêt. Appuyez sur Ctrl+C pour arrêter.`)
}

async function main() {
  const options = parseArgs()

  try {
    await stat(options.src)
  } catch {
    log.error(`Le dossier source "${options.src}" n'existe pas.`)
    log.info(`Vérifiez le chemin et utilisez des guillemets s'il contient des espaces.`)
    process.exit(1)
  }

  if (options.watch) {
    await watch(options)
  } else {
    await build(options)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    log.error(`Erreur fatale : ${err.stack}`)
    process.exit(1)
  })
}

export { build, watch }
