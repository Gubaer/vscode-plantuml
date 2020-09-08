import * as vscode from 'vscode';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as path from 'path';

import { IRender, RenderTask, RenderError } from './interfaces'
import { Diagram } from '../diagram/diagram';
import { config } from '../config';
import { localize, extensionPath } from '../common';
import { addFileIndex } from '../tools';
import { processWrapper } from './processWrapper';

class LocalRender implements IRender {

    /**
     * Indicates the exporter should limt concurrency or not.
     * @returns boolean
     */
    limitConcurrency(): boolean {
        return true;
    }
    /**
     * formats return an string array of formats that the exporter supports.
     * @returns an array of supported formats
     */
    formats(): string[] {
        return [
            "png",
            "svg",
            "emf",
            "eps",
            "pdf",
            "vdx",
            "xmi",
            "scxml",
            "html",
            "txt",
            "utxt",
            "latex",
            "latex:nopreamble"
        ];
    }
    /**
     * export a diagram to file or to Buffer.
     * @param diagram The diagram to export.
     * @param format format of export file.
     * @param savePath if savePath is given, it exports to a file, or, to Buffer.
     * @returns ExportTask.
     */
    render(diagram: Diagram, format: string, savePath: string): RenderTask {
        return this.createTask(diagram, "-pipe", savePath, format);
    }

    getMapData(diagram: Diagram, savePath: string): RenderTask {
        return this.createTask(diagram, "-pipemap", savePath);
    }
    private createTask(diagram: Diagram, taskType: string, savePath: string, format?: string): RenderTask {
        if (!config.java) {
            let pms = Promise.reject(localize(5, null));
            return <RenderTask>{ promise: pms };
        }
        if (!fs.existsSync(config.jar(diagram.parentUri))) {
            let pms = Promise.reject(localize(6, null, extensionPath));
            return <RenderTask>{ promise: pms };
        }

        let processes: child_process.ChildProcess[] = [];
        let buffers: Buffer[] = [];
        //make a promise chain that export only one page at a time
        //but processes are all started at the begining, and recorded for later process.
        let pms = [...Array(diagram.pageCount).keys()].reduce(
            (pChain, index) => {
                
                // if the final output format is 'emf', generate an  'svg'
                // first. We will deal with 'emf' later.
                let origFormat = format;
                if (format == "emf") {
                    format = "svg";
                    let savePathParsed = path.parse(savePath);
                    savePath = path.format({
                        dir: savePathParsed.dir,
                        name: savePathParsed.name,
                        ext: ".svg"
                    });
                }

                let params = [
                    '-Djava.awt.headless=true',
                    '-jar',
                    config.jar(diagram.parentUri),
                    "-pipeimageindex",
                    `${index}`,
                    '-charset',
                    'utf-8',
                ];

                let includePath = ''
                if (diagram.dir && path.isAbsolute(diagram.dir)) {
                    includePath = diagram.dir;
                }

                let ws = vscode.workspace.getWorkspaceFolder(diagram.parentUri);
                let folderPaths = config.includepaths(diagram.parentUri);
                for (let folderPath of folderPaths) {
                    if (!folderPath) continue;
                    if (!path.isAbsolute(folderPath)) {
                        folderPath = path.join(ws.uri.fsPath, folderPath);
                    }
                    includePath = includePath + path.delimiter + folderPath;
                }

                let diagramsRoot = config.diagramsRoot(diagram.parentUri);
                if (diagramsRoot) {
                    includePath = includePath + path.delimiter + diagramsRoot.fsPath;
                }

                params.unshift('-Dplantuml.include.path=' + includePath);

                // Add user java args
                params.unshift(...config.commandArgs(diagram.parentUri));
                // Jar args
                params.push(taskType);
                if (format) params.push("-t" + format);
                if (diagram.path) params.push("-filename", path.basename(diagram.path));
                // Add user jar args
                params.push(...config.jarArgs(diagram.parentUri));
                let process : any = child_process.spawn(config.java, params);
                processes.push(process);

                return pChain.then(
                    () => {

                        if (process.killed) {
                            buffers = null;
                            return Promise.resolve(null);
                        }

                        if (diagram && diagram.content) {
                            process.stdin.write(diagram.content);
                            process.stdin.end();
                        }
                        let savePath2 = savePath ? addFileIndex(savePath, index, diagram.pageCount) : "";

                        let pms = processWrapper(process, savePath2).then(
                            stdout => buffers.push(stdout),
                            err => Promise.reject(<RenderError>{ error: localize(10, null, diagram.title, err.error), out: err.out })
                        ).then(() => {
                            if (origFormat == "emf") {
                                // TODO(karl): make configurable, config.inscape object, similar to config.java
                                let inkscape = "/usr/bin/inkscape";
            
                                // derive output path for the EMF file from the output path
                                // of the SVG file
                                let svgInputFile = path.parse(savePath2);
                                let emfOutputFileName = path.format({
                                    dir: svgInputFile.dir,
                                    name: svgInputFile.name,
                                    ext: ".emf"
                                });
                                
                                let params = [
                                    '--without-gui',
                                    `--export-emf=${emfOutputFileName}`,
                                    savePath2
                                ];
                                
                                let process : any = child_process.spawn(inkscape, params);

                                // TODO(karl): not very elegant ...
                                console.log(`Generating EMF file: input=${savePath2}, output=${emfOutputFileName}`)
                                child_process.execFileSync(inkscape, params);
                                return "";
                            }
                         });
                        return pms;
                    },
                    err => {
                        return Promise.reject(err);
                    }
                )
            },
            Promise.resolve(Buffer.alloc(0))
        );
        return <RenderTask>{
            processes: processes,
            promise: new Promise<Buffer[]>(
                (resolve, reject) => {
                    pms.then(
                        () => {
                            resolve(buffers);
                        },
                        err => {
                            reject(err);
                        }
                    )
                }
            )
        }
    }
}
export const localRender = new LocalRender();
