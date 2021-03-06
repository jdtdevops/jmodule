import { ResourceType, ResourceStatus, ResourceLoadStrategy, ModuleStatus } from './config';
import { resolveUrlByFetch } from './utils/fetchCode';
import JModuleManager from './globalManager';
import { ModuleHook } from './hook';
import { wrapperFetchedCodeHook } from './utils/wrapperFetchedCode';
import { resourceTypes } from './utils/resourceResolver';
import manager from './globalManager';
import { JModule } from './module';
import { elementsToPromise } from './utils/elementsToPromise';

function injectElementModifier (
    element: HTMLElement, 
    elementModifier?: (element: HTMLElement) => void
) :HTMLElement{
    if (elementModifier && typeof elementModifier === 'function') {
        elementModifier(element);
    }
    return element;
}
function loadScript(url: string, from: string, elementModifier?: (script: HTMLScriptElement) => void): Promise<HTMLScriptElement> {
    const script = document.createElement('script');
    script.setAttribute('src', url); // skip proxy
    script.async = false;
    script.dataset.jmoduleFrom = from;
    elementModifier && elementModifier(script);
    document.body.appendChild(script);
    return new Promise((resolve, reject) => {
        script.onerror = () => reject(new Error(`LoadScriptError: ${url}`));
        script.onload = () => resolve(script);
    });
}

function createLink(url: string, from: string, elementModifier?: (element: HTMLElement) => void): HTMLLinkElement {
    const styleDom = document.createElement('link');
    styleDom.setAttribute('rel', 'preload');
    styleDom.setAttribute('as', 'style');
    styleDom.setAttribute('href', url);
    styleDom.dataset.jmoduleFrom = from;
    elementModifier && elementModifier(styleDom);
    return styleDom;
}

function patchInitUrl(url: string): string {
    return `${new URL(url, window.location.href)}${url.indexOf('?') > 0 ? '&' : '?' }__v__=${Date.now()}`;
}

const queryReg = /\?.+$/;

function cacheUrlMap(metadata: ResourceMetadata, sourceUrl: string, prefix?: string) {
    const { asyncFiles = [] } = metadata;
    asyncFiles.forEach(file => {
        const key = file.replace(queryReg, '');
        const targetUrl = resolveUrl(file, sourceUrl, metadata, prefix);
        manager.setFileMapCache(key, [targetUrl, sourceUrl]);
        manager.appendFileList(key);
    });
}

function resolveUrl(url: string, sourceUrl: string, metadata?: ResourceMetadata, prefix?: string): string {
    try {
        if (url.startsWith('X_WEBPACK_SERVER')) {
            console.warn('X_WEBPACK_SERVER ?????????, ?????????????????????');
            if (metadata?.asyncFiles) {
                // ?????????????????????
                url = url.replace(/^X_WEBPACK_SERVER\/?/, '');
            } else { // ?????????????????????
                url = url.replace(/^X_WEBPACK_SERVER/, '');
            }
        }
        if (!prefix) {
            return new URL(url, sourceUrl).href;
        }
        return `${prefix}${url}`;
    } catch (e) {
        // ignore error: ?????????????????????IE????????? ????????????
        return url;
    }
}

export interface ResourceMetadata {
    js: string[],
    css: string[],
    asyncFiles: string[],
}

export interface ResourceOptions {
    type?: string,
    prefix?: string,
    strategy?: ResourceLoadStrategy,
}


const scriptCacheByUrl: { [url: string]: HTMLScriptElement } = {};

/**
 * ??????URL?????????????????????????????????
 * @class
 * @param {String<url>} ????????????
 */
export class Resource extends ModuleHook {
    private resolveScript!: (elements: HTMLScriptElement[]) => void;
    private rejectScript!: (error: Error) => void;
    private styleLoading?: Promise<HTMLLinkElement[]>;
    private scriptLoading?: Promise<HTMLScriptElement[]>;
    private appliedScript = false;
    private static asyncFilesMap: { [key: string]: Resource | undefined } = {};
    
    resolveInit!: () => void;
    rejectInit!: (error: Error) => void;
    metadata?: ResourceMetadata;
    url = '';
    initScriptElement?: HTMLScriptElement;
    styleElements: HTMLLinkElement[] = [];
    appendedAsyncStyleElements?: NodeListOf<Element>;
    scriptElements: HTMLScriptElement[] = [];
    server!: string;
    styleMounted = false;
    status: ResourceStatus = ResourceStatus.Init;
    type!: string; // ??????????????????
    prefix?: string;
    afterApplyScript!: Promise<HTMLScriptElement[]>;
    afterInit!: Promise<void>;
    strategy!: ResourceLoadStrategy; // ????????????????????????????????????
    cachedUrlMap: {
        [key: string]: string
    } = {};

    /**
     * @constructor
     */
    constructor(url: string, options?: ResourceOptions) {
        super();
        if (!url && typeof url !== 'string') {
            throw new Error('?????? Resource ????????????, ??????sourceUrl');
        }
        const { href: wholeUrl, origin: server } = new URL(url, window.location.href);
        if (JModuleManager.resource(wholeUrl)) {
            return <Resource>JModuleManager.resource(wholeUrl);
        }
        this.url = wholeUrl;
        this.server = server;
        this.type = options?.type || url.split('.').pop() || 'js';
        this.prefix = options?.prefix?.replace('[resourceOrigin]', this.server);
        this.afterInit = new Promise((resolve, reject) => {
            this.resolveInit = resolve;
            this.rejectInit = reject;
        });
        this.afterApplyScript = new Promise((resolve, reject) => {
            this.resolveScript = resolve;
            this.rejectScript = reject;
        });
        this.strategy = options?.strategy ?? ResourceLoadStrategy.Element;
        JModuleManager.resource(this.url, this);
    }

    static enableAsyncChunk() {
        console.warn('Resource.enableAsyncChunk() is deprecated, just remove it');
    }

    static getResource(sourceUrl?: string): Resource | void {
        console.warn('Resource.getResource() is deprecated, use JModuleManager.getInstance() instead');
        return JModuleManager.resource(sourceUrl);
    }

    static getTrueResourceUrl(url: string): { resource: Resource, filepath: string } | void {
        let resource: Resource | undefined;
        let filepath: string | undefined;
        Object.keys(Resource.asyncFilesMap).some(file => {
            if (url.includes(file)) {
                resource = Resource.asyncFilesMap[file];
                filepath = file;
                return true;
            }
        });
        return resource && filepath ? { resource, filepath } : undefined;
    }

    static setResourceData(metadata: ResourceMetadata, sourceUrl: string): Resource {
        const resource = JModuleManager.resource(sourceUrl);
        if (resource) {
            resource.metadata = metadata;
            resource.setStatus(ResourceStatus.Initialized);
            resource.resolveInit();
            return resource;
        } else {
            throw new Error(`?????????${sourceUrl}????????? resource ??????`);
        }
    }

    static defineType(type: string, typeHandler: (resource: Resource, defaultUrl: string) => Promise<string>) {
        Resource.addHook('resource:resolveEntry', async (resource: Resource, defaultUrl: string) => {
            if (resource.type === type && typeof typeHandler === 'function') {
                return [resource, await typeHandler(resource, defaultUrl)]
            }
            return [resource, defaultUrl];
        });
    }

    // ?????????????????????
    async init() {
        if (this.initScriptElement || this.status === ResourceStatus.Initializing) {
            return Promise.resolve();
        }
        this.setStatus(ResourceStatus.Initializing);
        try {
            const [, url] = await Resource.runHook('resource:resolveEntry', this, patchInitUrl(this.url));
            const res = await loadScript(url, this.url, (script) => {
                script.async = true;
                this.initScriptElement = script;
                scriptCacheByUrl[this.url] = script;
            });
            return res;
        } catch (e) {
            this.setStatus(ResourceStatus.InitializeFailed);
            console.error(`??????????????????: ${this.url}`);
            this.rejectInit(e as Error);
        }
    }

    resolveUrl(url: string) {
        return resolveUrl(url, this.url, this.metadata, this.prefix);
    }

    setStatus(status: ResourceStatus) {
        this.status = status;
        const modules = JModuleManager.getModulesByResourceUrl(this.url);
        modules.forEach((module: JModule) => {
            // ??????????????????????????????????????????????????????
            if (status === ResourceStatus.Initializing && module.status === ModuleStatus.initialized) {
                module.status = ModuleStatus.loading;
            }
            window.dispatchEvent(new CustomEvent(`resource.${module.key}.statusChange`, {
                detail: this,
            }));
        });
    }

    async applyScript(elementModifier?: ElementModifier): Promise<HTMLScriptElement[]> {
        if (!this.metadata) {
            return Promise.reject(new Error(`no resource metadata: ${this.url}`));
        }
        if (this.appliedScript) {
            return Promise.resolve(this.scriptElements);
        }
        if (this.scriptLoading) {
            return this.scriptLoading;
        }
        this.setStatus(ResourceStatus.ApplyScript);
        this.scriptElements = [];
        const jsUrls = (this.metadata.js || []).map(url => this.resolveUrl(url));
        const getEntryUrls = async () => this.strategy === ResourceLoadStrategy.Fetch
            ? await Promise.all(jsUrls.map(url => resolveUrlByFetch(
                url,
                this.url,
                ResourceType.Script,
            )))
            : (cacheUrlMap(this.metadata as ResourceMetadata, this.url, this.prefix), jsUrls);
        this.scriptLoading = getEntryUrls().then((entryUrls) => Promise.all(entryUrls.map(url => loadScript(
            url,
            this.url,
            elementModifier,
        )))).then((scripts) => {
            this.setStatus(ResourceStatus.ScriptResolved);
            this.resolveScript(scripts);
            this.scriptElements = scripts;
            this.appliedScript = true;
            return this.scriptElements;
        }).catch((error) => {
            this.setStatus(ResourceStatus.ScriptError);
            this.rejectScript(error);
            throw error;
        });
        return this.scriptLoading;
    }

    async applyStyle(elementModifier?: ElementModifier): Promise<HTMLLinkElement[]> {
        if (!this.metadata) {
            return Promise.reject(new Error('no resource metadata'));
        }
        const { css = [] } = this.metadata;
        const { length } = this.styleElements;
        if (!this.styleLoading) {
            this.setStatus(ResourceStatus.ApplyStyle);
            if (css.length !== length) {
                const cssUrls = (this.metadata.css || []).map(url => this.resolveUrl(url));
                const entryUrls = await (async () => this.strategy === ResourceLoadStrategy.Fetch
                    ? await Promise.all(cssUrls.map(url => resolveUrlByFetch(
                        url,
                        this.url,
                        ResourceType.Style,
                    )))
                    : cssUrls)();
                this.styleElements = entryUrls.map(url => createLink(url, this.url, elementModifier));
            }
            const styleDefer = elementsToPromise(
                this.styleElements,
                el => document.head.appendChild(el),
                el => el.setAttribute('rel', 'stylesheet'),
            );
            this.appendedAsyncStyleElements?.forEach(item => document.head.appendChild(item));
            this.styleLoading = styleDefer.then((res) => {
                this.styleMounted = true;
                this.setStatus(ResourceStatus.StyleResolved);
                if (res.errors.length) {
                    this.setStatus(ResourceStatus.StyleError);
                    console.error(res.errors);
                }
                return res.results;
            });
        }
        return this.styleLoading;
    }

    preload(elementModifier?: ElementModifier) {
        if (!this.metadata) {
            throw new Error('no resource metadata');
        }
        if (this.status === ResourceStatus.Preloading) {
            return;
        }
        this.setStatus(ResourceStatus.Preloading);
        const { css = [], js = [] } = this.metadata;
        const defers = [
            { type: 'script', urls: js },
            { type: 'style', urls: css },
        ].map(({ type, urls }) => {
            const defers = urls.map(url => {
                const targetUrl = this.resolveUrl(url);
                if (this.strategy === ResourceLoadStrategy.Fetch) {
                    const resourceType = type === 'script' ? ResourceType.Script : ResourceType.Style;
                    return resolveUrlByFetch(targetUrl, this.url, resourceType).then(resUrl => {
                        this.cachedUrlMap[targetUrl] = resUrl;
                    });
                } else {
                    return new Promise((resolve, reject) => {
                        const preloadLink = document.createElement("link");
                        preloadLink.href = targetUrl;
                        preloadLink.rel = "preload";
                        preloadLink.as = type;
                        preloadLink.onload = resolve;
                        preloadLink.onerror = reject;
                        document.head.appendChild(injectElementModifier(preloadLink, elementModifier))
                    });
                }
            });
            return Promise.all(defers);
        });
        Promise.all(defers).then(() => {
            this.setStatus(ResourceStatus.Preloaded);
        }).catch(() => {
            this.setStatus(ResourceStatus.PreloadFailed);
        });
        return;
    }

    /**
     * ????????????
     */
    removeStyle() {
        // ????????? link
        (this.styleElements || []).forEach(item => item.remove());
        // ????????????????????? link
        const asyncLinks = document.querySelectorAll(`link[data-jmodule-from="${this.url}"], style[data-jmodule-from="${this.url}"]`);
        asyncLinks.forEach(item => item.remove());
        this.appendedAsyncStyleElements = asyncLinks;
        this.styleMounted = false;
        this.styleLoading = undefined;
    }

    /**
     * ??????????????????
     */
    destroy() {
        this.removeStyle(); // ????????????
        this.initScriptElement = undefined;
        this.scriptElements = [];
        this.styleElements = []; // ?????????DOM???????????????
        JModuleManager.resource(this.url, null);
    }
}

Resource.addHook('resource:transformFetchResult', wrapperFetchedCodeHook);
resourceTypes.forEach(([type, typeHandler]) => {
    Resource.defineType(type, typeHandler);
});

