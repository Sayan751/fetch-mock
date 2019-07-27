const debug = require('debug')('fetch-mock')
const responseBuilder = require('./response-builder');
const requestUtils = require('./request-utils');
const FetchMock = {};

// see https://heycam.github.io/webidl/#aborterror for the standardised interface
// Note that this differs slightly from node-fetch
class AbortError extends Error {
	constructor() {
		super(...arguments);
		this.name = 'AbortError';
		this.message = 'The operation was aborted.';

		// Do not include this class in the stacktrace
		Error.captureStackTrace(this, this.constructor);
	}
}

const resolve = async (
	{ response, responseIsFetch = false },
	url,
	options,
	request
) => {
	debug('Recursively resolving function and promise responses')
	// We want to allow things like
	// - function returning a Promise for a response
	// - delaying (using a timeout Promise) a function's execution to generate
	//   a response
	// Because of this we can't safely check for function before Promisey-ness,
	// or vice versa. So to keep it DRY, and flexible, we keep trying until we
	// have something that looks like neither Promise nor function
	while (true) {
		if (typeof response === 'function') {
			debug('  Response is a function')
			// in the case of falling back to the network we need to make sure we're using
			// the original Request instance, not our normalised url + options
			if (responseIsFetch) {
				if (request) {
					debug('  > Calling fetch with Request instance')
					return response(request)
				}
				debug('  > Calling fetch with url and options')
				return response(url, options);
			} else {
				debug('  > Calling custom matcher function')
				return response(url, options, request);
			}
		} else if (typeof response.then === 'function') {
			debug('  Response is a promise')
			debug('  > Resolving promise')
			response = await response;
		} else {
			debug('  Response is not a function or a promise')
			debug('  > Returning response for conversion into Response instance')
			return response;
		}
	}
};

FetchMock.fetchHandler = function(url, options, request) {
	debug('**HANDLING NEW FETCH**');
	({ url, options, request } = requestUtils.normalizeRequest(
		url,
		options,
		this.config.Request
	));

	const route = this.executeRouter(url, options, request);

	// this is used to power the .flush() method
	let done;
	this._holdingPromises.push(new this.config.Promise(res => (done = res)));

	// wrapped in this promise to make sure we respect custom Promise
	// constructors defined by the user
	return new this.config.Promise((res, rej) => {
		if (options && options.signal) {
			debug('options.signal exists - setting up fetch aborting')
			const abort = () => {
				rej(new AbortError());
				done();
			};
			if (options.signal.aborted) {
				debug('options.signal is already aborted- abort the fetch')
				abort();
			}
			options.signal.addEventListener('abort', abort);
		}

		this.generateResponse(route, url, options, request)
			.then(res, rej)
			.then(done, done);
	});
};

FetchMock.fetchHandler.isMock = true;

FetchMock.executeRouter = function(url, options, request) {
	debug('Attempting to match request to defined routes')
	if (this.config.fallbackToNetwork === 'always') {
		debug('  Configured with fallbackToNetwork=always - passing through to fetch')
		return { response: this.getNativeFetch(), responseIsFetch: true };
	}

	const match = this.router(url, options, request);

	if (match) {
		debug('  Matching route found')
		return match;
	}

	if (this.config.warnOnFallback) {
		console.warn(`Unmatched ${(options && options.method) || 'GET'} to ${url}`); // eslint-disable-line
	}

	this.push({ url, options, request, isUnmatched: true });

	if (this.fallbackResponse) {
		debug('  No matching route found - using fallbackResponse')
		return { response: this.fallbackResponse };
	}

	if (!this.config.fallbackToNetwork) {
		throw new Error(
			`fetch-mock: No fallback response defined for ${(options &&
				options.method) ||
				'GET'} to ${url}`
		);
	}

	debug('  Configured to fallbackToNetwork - passing through to fetch')
	return { response: this.getNativeFetch(), responseIsFetch: true };
};

FetchMock.generateResponse = async function(route, url, options, request) {
	const response = await resolve(route, url, options, request);

	// If the response says to throw an error, throw it
	// Type checking is to deal with sinon spies having a throws property :-0
	if (response.throws && typeof response !== 'function') {
		debug('response.throws is defined - throwing an error')
		throw response.throws;
	}

	// If the response is a pre-made Response, respond with it
	if (this.config.Response.prototype.isPrototypeOf(response)) {
		debug('response is already a Response instance - returning it')
		return response;
	}

	// finally, if we need to convert config into a response, we do it
	return responseBuilder({
		url,
		responseConfig: response,
		fetchMock: this,
		route
	});
};

FetchMock.router = function(url, options, request) {
	const route = this.routes.find(route => route.matcher(url, options, request));

	if (route) {
		this.push({
			url,
			options,
			request,
			identifier: route.identifier
		});
		return route;
	}
};

FetchMock.getNativeFetch = function() {
	const func = this.realFetch || (this.isSandbox && this.config.fetch);
	if (!func) {
		throw new Error(
			'fetch-mock: Falling back to network only available on gloabl fetch-mock, or by setting config.fetch on sandboxed fetch-mock'
		);
	}
	return func;
};

FetchMock.push = function({ url, options, request, isUnmatched, identifier }) {
	const args = [url, options];
	args.request = request;
	args.identifier = identifier;
	args.isUnmatched = isUnmatched;
	this._calls.push(args);
};

module.exports = FetchMock;
