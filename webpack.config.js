const path = require('node:path')
const { ModuleFederationPlugin } = require('webpack').container
const packageJson = require('./package.json')

// Signal K's admin UI looks up a federated webapp by this name — hyphens
// (and @, /) replaced with underscores — both for the <script> tag it
// expects at /<package-name>/remoteEntry.js and for the global var that
// script defines. Getting this wrong produces "Module ... is not available."
const federationName = packageJson.name.replace(/[-@/]/g, '_')

module.exports = {
  entry: './src/components/AppPanel',
  mode: 'production',
  output: {
    path: path.resolve(__dirname, 'public')
  },
  resolve: {
    extensions: ['.tsx', '.ts', '.js', '.jsx']
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        exclude: /node_modules/,
        options: {
          configFile: 'tsconfig.webpack.json'
        }
      }
    ]
  },
  plugins: [
    new ModuleFederationPlugin({
      name: federationName,
      library: { type: 'var', name: federationName },
      filename: 'remoteEntry.js',
      exposes: {
        './AppPanel': './src/components/AppPanel'
      },
      // Singleton: the exposed component's hooks must run against the same
      // React instance the admin UI itself renders with, not a bundled copy.
      shared: [{ react: { singleton: true } }]
    })
  ]
}
