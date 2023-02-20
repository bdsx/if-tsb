
import path = require('path');
import fs = require('fs');
import { BundlerModuleId } from './module';

function findUp(pathname:string):string|null {
	let directory = process.cwd();
	const {root} = path.parse(directory);

	for (;;) {
        const foundPath = path.resolve(directory, pathname);
        try {
            const stat = fs.statSync(foundPath);
            if (stat.isFile()) {
                return foundPath;
            }
        } catch {}
		if (directory === root) {
			return null;
		}
		directory = path.dirname(directory);
	}
}

function pkgDir() {
	const filePath = findUp('package.json');
	return filePath && path.dirname(filePath);
}

const {env} = process;

const isWritable = (path:string) => {
	try {
		fs.accessSync(path, fs.constants.W_OK);
		return true;
	} catch (_) {
		return false;
	}
};

function getNodeModuleDirectory(directory:string) {
	const nodeModules = path.join(directory, 'node_modules');

	if (
		!isWritable(nodeModules) &&
		(fs.existsSync(nodeModules) || !isWritable(path.join(directory)))
	) {
		return;
	}

	return nodeModules;
}

function findCacheDir(name:string) {
	if (env.CACHE_DIR && ['true', 'false', '1', '0'].indexOf(env.CACHE_DIR) === -1) {
		return path.join(env.CACHE_DIR, 'find-cache-dir');
	}

    const directory = pkgDir();
	if (!directory) {
		return;
	}

	const nodeModules = getNodeModuleDirectory(directory);
	if (!nodeModules) {
		return undefined;
	}

	return path.join(directory, 'node_modules', '.cache', name);
}

export const cacheDir = findCacheDir('if-tsb') || './.if-tsb.cache';
export const cacheMapPath = path.join(cacheDir, 'cachemap.json');
export const CACHE_VERSION = 'TSBC-0.12';
export const CACHE_SIGNATURE = Buffer.from('\0'+CACHE_VERSION);

export function getCacheFilePath(id:BundlerModuleId):string
{
    return path.join(cacheDir, id.number+'');
}
