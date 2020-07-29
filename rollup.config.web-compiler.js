import fs from 'fs'
import resolve from '@rollup/plugin-node-resolve'
import json from '@rollup/plugin-json'
import commonjs from '@rollup/plugin-commonjs'
import { terser } from 'rollup-plugin-terser'
import gzip from 'rollup-plugin-gzip'
import brotli from 'rollup-plugin-brotli'

const createExample = () => ({ writeBundle(bundle) {
fs.writeFileSync('./web-compiler-example.html', `<!DOCTYPE html>
  <html lang='en'>
    <head>
      <meta charset='UTF-8'>
      <title></title>
      <script type='module'>
        import('./web-compiler.mjs').then(mod => {
          let code = \`
            <script>
              let a
            <\\/script>

            <style>
              main { color: blue; }
            <\\/style>

            <main>
              Hello
            <\\/main>
          \`

          const module = mod.compile(code)
            .replace('malinajs/runtime.js', './runtime.js')

          let script = document.createElement('script')

          script.type = 'module'

          script.textContent = \`
            \${module}
            widget(document.body, {});
          \`

          document.body.appendChild(script)
        })
      </script>
    </head>
    <body></body>
  </html>
`)
}})

export default [{
  input: './src/compiler.js',
  output: {
    format: 'es',
    sourcemap: true,
    file: './web-compiler.mjs',
    name: 'compiler',
  },
  external: [],
  plugins: [
    resolve(),
    commonjs(),
    json(),
    terser(),
    gzip(),
    brotli(),
    (process.env.gen_exa ? createExample() : {})
  ]
}];
