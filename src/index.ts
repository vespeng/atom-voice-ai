/**
 * Atom Voice AI - Cloudflare Worker for real-time voice interaction
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * This worker integrates with Realtime Kit to provide AI-powered voice services
 * including speech-to-text, text-to-speech, and AI-based conversation processing.
 */

import { TextComponent, RealtimeKitTransport, RealtimeAgent } from '@cloudflare/realtime-agents';

// Workers AI STT（@cf/deepgram/nova-3）
class CloudflareSTT extends TextComponent {
	env: Env;

	constructor(env: Env) {
		super();
		this.env = env;
	}

	async onAudio(audio: ArrayBuffer, emitTranscript: (text: string) => void) {
		const result = await this.env.AI.run('@cf/deepgram/nova-3', {
			audio: [...new Uint8Array(audio)],
		});

		if (result?.text) {
			emitTranscript(result.text);
		}
	}
}

// Workers AI TTS（@cf/deepgram/aura-2）
class CloudflareTTS extends TextComponent {
	env: Env;

	constructor(env: Env) {
		super();
		this.env = env;
	}

	async onText(text: string, emitAudio: (audio: ArrayBuffer) => void) {
		const result = await this.env.AI.run('@cf/deepgram/aura-2', {
			text,
		}, { returnRawResponse: true });

		if (result?.audio) {
			emitAudio(result.audio);
		}
	}
}

class MyTextProcessor extends TextComponent {
	env: Env;

	constructor(env: Env) {
		super();
		this.env = env;
	}

	async onTranscript(text: string, reply: (text: string) => void) {
		const { response } = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
			prompt: text,
		});
		reply(response!);
	}
}

export class MyAgent extends RealtimeAgent<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async init(agentId: string, meetingId: string, authToken: string, workerUrl: string, accountId: string, apiToken: string) {
		// Construct your text processor for generating responses to text
		const textProcessor = new MyTextProcessor(this.env);
		// Construct a Meeting object to join the RTK meeting
		const rtkTransport = new RealtimeKitTransport(meetingId, authToken);

		// Construct a pipeline to take in meeting audio, transcribe it using
		// Deepgram, and pass our generated responses through ElevenLabs to
		// be spoken in the meeting
		await this.initPipeline(
			[
				rtkTransport,
				new CloudflareSTT(this.env),
				textProcessor,
				new CloudflareTTS(this.env),
				rtkTransport,
			],
			agentId,
			workerUrl,
			accountId,
			apiToken,
		);

		const { meeting } = rtkTransport;

		// The RTK meeting object is accessible to us, so we can register handlers
		// on various events like participant joins/leaves, chat, etc.
		// This is optional
		meeting.participants.joined.on('participantJoined', (participant) => {
			textProcessor.speak(`Participant Joined ${participant.name}`);
		});
		meeting.participants.joined.on('participantLeft', (participant) => {
			textProcessor.speak(`Participant Left ${participant.name}`);
		});

		// Make sure to actually join the meeting after registering all handlers
		await meeting.join();
	}

	async deinit() {
		// Add any other cleanup logic required
		await this.deinitPipeline();
	}
}

export default {
	async fetch(request, env, _ctx): Promise<Response> {
		const url = new URL(request.url);
		const meetingId = url.searchParams.get('meetingId');
		if (!meetingId) {
			return new Response(null, { status: 400 });
		}

		const agentId = meetingId;
		const agent = env.MY_AGENT.idFromName(meetingId);
		const stub = env.MY_AGENT.get(agent);
		// The fetch method is implemented for handling internal pipeline logic
		if (url.pathname.startsWith('/agentsInternal')) {
			return stub.fetch(request);
		}

		// Your logic continues here
		switch (url.pathname) {
			case '/init':
				// This is the authToken for joining a meeting, it can be passed
				// in query parameters as well if needed
				const authHeader = request.headers.get('Authorization');
				if (!authHeader) {
					return new Response(null, { status: 401 });
				}

				// We just need the part after `Bearer `
				await stub.init(agentId, meetingId, authHeader.split(' ')[1], url.host, env.ACCOUNT_ID, env.API_TOKEN);

				return new Response(null, { status: 200 });
			case '/deinit':
				await stub.deinit();
				return new Response(null, { status: 200 });
		}

		return new Response(null, { status: 404 });
	},
} satisfies ExportedHandler<Env>;
