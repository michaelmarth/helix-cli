/*
 * Copyright 2018 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const chalk = require('chalk');
const glob = require('glob');
const path = require('path');
const fs = require('fs-extra');
const ProgressBar = require('progress');
const archiver = require('archiver');
const StaticCommand = require('./static.cmd.js');
const ActionBundler = require('./parcel/ActionBundler.js');
const { flattenDependencies } = require('./packager-utils.js');

class PackageCommand extends StaticCommand {
  constructor(logger) {
    super(logger);
    this._target = null;
    this._onlyModified = false;
    this._enableMinify = false;
  }

  // eslint-disable-next-line class-methods-use-this
  get requireConfigFile() {
    return false;
  }

  withTarget(value) {
    this._target = value;
    return this;
  }

  withOnlyModified(value) {
    this._onlyModified = value;
    return this;
  }

  withMinify(value) {
    this._enableMinify = value;
    return this;
  }

  async init() {
    await super.init();
    this._target = path.resolve(this.directory, this._target);
  }

  /**
   * Creates a .zip package that contains the contents to be deployed to openwhisk.
   * @param info The action info object
   * @param info.name Name of the action
   * @param info.main Main script of the action
   * @param info.externals External modules
   * @param info.requires Local dependencies
   * @param bar progress bar
   * @returns {Promise<any>} Promise that resolves to the package file {@code path}.
   */
  async createPackage(info, bar) {
    const { log } = this;

    const tick = (message, name) => {
      const shortname = name.replace(/\/package.json.*/, '').replace(/node_modules\//, '');
      bar.tick({
        action: name ? `packaging ${shortname}` : '',
      });
      if (message) {
        this.log.maybe({
          progress: true,
          level: 'info',
          message,
        });
      }
    };

    return new Promise((resolve, reject) => {
      const archiveName = path.basename(info.zipFile);
      let hadErrors = false;

      // create zip file for package
      const output = fs.createWriteStream(info.zipFile);
      const archive = archiver('zip');

      log.debug(`preparing package ${archiveName}`);
      output.on('close', () => {
        if (!hadErrors) {
          log.debug(`${archiveName}: Created package. ${archive.pointer()} total bytes`);
          // eslint-disable-next-line no-param-reassign
          info.archiveSize = archive.pointer();
          this.emit('create-package', info);
          resolve(info);
        }
      });
      archive.on('entry', (data) => {
        log.debug(`${archiveName}: A ${data.name}`);
        tick('', data.name);
      });
      archive.on('warning', (err) => {
        log.error(`${chalk.redBright('[error] ')}Unable to create archive: ${err.message}`);
        hadErrors = true;
        reject(err);
      });
      archive.on('error', (err) => {
        log.error(`${chalk.redBright('[error] ')}Unable to create archive: ${err.message}`);
        hadErrors = true;
        reject(err);
      });
      archive.pipe(output);

      const packageJson = {
        name: info.name,
        version: '1.0',
        description: `Lambda function of ${info.name}`,
        main: path.basename(info.main),
        license: 'Apache-2.0',
      };

      archive.append(JSON.stringify(packageJson, null, '  '), { name: 'package.json' });
      archive.file(info.bundlePath, { name: path.basename(info.main) });
      archive.finalize();
    });
  }

  /**
   * Creates the action bundles
   * @param {*[]} scripts the scripts information
   * @param {ProgressBar} bar the progress bar
   */
  async createBundles(scripts, bar) {
    const progressHandler = (percent, msg, ...args) => {
      /* eslint-disable no-param-reassign */
      const action = args.length > 0 ? `${msg} ${args[0]}` : msg;
      const rt = bar.renderThrottle;
      if (msg !== 'building') {
        // this is kind of a hack to force redraw for non-bundling steps.
        bar.renderThrottle = 0;
      }
      bar.update(percent * 0.8, { action });
      bar.renderThrottle = rt;
      /* eslint-enable no-param-reassign */
    };

    // create the bundles
    const bundler = new ActionBundler()
      .withDirectory(this._target)
      .withModulePaths(['node_modules', path.resolve(__dirname, '..', 'node_modules')])
      .withLogger(this.log)
      .withProgressHandler(progressHandler)
      .withMinify(this._enableMinify);
    const files = {};
    scripts.forEach((script) => {
      files[script.name] = path.resolve(this._target, script.main);
    });
    const stats = await bundler.run(files);
    if (stats.errors) {
      stats.errors.forEach(this.log.error);
    }
    if (stats.warnings) {
      stats.warnings.forEach(this.log.warn);
    }
  }

  async run() {
    await this.init();

    // get the list of scripts from the info files
    const infos = [...glob.sync(`${this._target}/**/*.info.json`)];
    const scriptInfos = await Promise.all(infos.map(info => fs.readJSON(info)));

    // resolve dependencies
    let scripts = flattenDependencies(scriptInfos);

    // add the static script if missing
    if (!scripts.find(script => script.isStatic) && this._buildStatic) {
      // add static action
      scripts.push({
        main: path.resolve(__dirname, 'openwhisk', 'static.js'),
        isStatic: true,
        requires: [],
      });
    }

    // filter out the ones that already have the info and a valid zip file
    if (this._onlyModified) {
      await Promise.all(scripts.map(async (script) => {
        // check if zip exists, and if not, clear the path entry
        if (!script.zipFile || !(await fs.pathExists(script.zipFile))) {
          // eslint-disable-next-line no-param-reassign
          delete script.zipFile;
        }
      }));
      scripts.filter(script => script.zipFile).forEach((script) => {
        this.emit('ignore-package', script);
      });
      scripts = scripts.filter(script => !script.zipFile);
    }

    if (scripts.length > 0) {
      // generate additional infos
      scripts.forEach((script) => {
        /* eslint-disable no-param-reassign */
        script.name = path.basename(script.main, '.js');
        script.bundleName = `${script.name}.bundle.js`;
        script.bundlePath = path.resolve(this._target, script.bundleName);
        script.dirname = script.isStatic ? '' : path.dirname(script.main);
        script.archiveName = `${script.name}.zip`;
        script.zipFile = path.resolve(this._target, script.dirname, script.archiveName);
        script.infoFile = path.resolve(this._target, script.dirname, `${script.name}.info.json`);
        /* eslint-enable no-param-reassign */
      });

      // we reserve 80% for bundling the scripts and 20% for creating the zip files.
      const bar = new ProgressBar('[:bar] :action :elapseds', {
        total: scripts.length * 2 * 5,
        width: 50,
        renderThrottle: 50,
        stream: process.stdout,
      });

      // create bundles
      await this.createBundles(scripts, bar);

      // package actions
      await Promise.all(scripts.map(script => this.createPackage(script, bar)));

      // write back the updated infos
      // eslint-disable-next-line max-len
      await Promise.all(scripts.map(script => fs.writeJson(script.infoFile, script, { spaces: 2 })));
    }

    this.log.info('✅  packaging completed');
    return this;
  }
}
module.exports = PackageCommand;
