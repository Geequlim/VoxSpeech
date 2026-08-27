#include "audio-io.h"
#include "qwen.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <filesystem>
#include <string>

namespace {

using Clock = std::chrono::steady_clock;

struct Args {
	const char * model = nullptr;
	const char * codec = nullptr;
	const char * ref_wav = nullptr;
	const char * ref_text = nullptr;
	const char * output_dir = nullptr;
	int max_new_tokens = 24;
};

struct StreamState {
	FILE * pcm = nullptr;
	Clock::time_point started;
	double first_audio_ms = -1.0;
	int chunks = 0;
	int64_t samples = 0;
};

struct CancelState {
	int polls = 0;
};

double elapsed_ms(Clock::time_point started) {
	return std::chrono::duration<double, std::milli>(Clock::now() - started).count();
}

bool write_pcm_chunk(const float * samples, int n_samples, void * user_data) {
	auto & state = *static_cast<StreamState *>(user_data);
	if (state.first_audio_ms < 0.0) {
		state.first_audio_ms = elapsed_ms(state.started);
	}
	for (int i = 0; i < n_samples; ++i) {
		const float sample = std::max(-1.0f, std::min(1.0f, samples[i]));
		const auto pcm = static_cast<int16_t>(std::lrint(sample * 32767.0f));
		if (std::fwrite(&pcm, sizeof(pcm), 1, state.pcm) != 1) {
			return false;
		}
	}
	state.chunks += 1;
	state.samples += n_samples;
	return true;
}

bool cancel_after_first_poll(void * user_data) {
	auto & state = *static_cast<CancelState *>(user_data);
	state.polls += 1;
	return state.polls >= 1;
}

bool parse_args(int argc, char ** argv, Args & args) {
	for (int i = 1; i < argc; ++i) {
		const std::string arg = argv[i];
		auto next = [&]() -> const char * {
			return i + 1 < argc ? argv[++i] : nullptr;
		};
		if (arg == "--model") {
			args.model = next();
		} else if (arg == "--codec") {
			args.codec = next();
		} else if (arg == "--ref-wav") {
			args.ref_wav = next();
		} else if (arg == "--ref-text") {
			args.ref_text = next();
		} else if (arg == "--output-dir") {
			args.output_dir = next();
		} else if (arg == "--max-new") {
			const char * value = next();
			args.max_new_tokens = value ? std::atoi(value) : 0;
		} else {
			return false;
		}
	}
	return args.model && args.codec && args.output_dir && args.max_new_tokens > 0 &&
		((args.ref_wav && args.ref_text) || (!args.ref_wav && !args.ref_text));
}

void configure_synthesis(qt_tts_params & params, const char * text, int max_new_tokens) {
	qt_tts_default_params(&params);
	params.text = text;
	params.lang = "Chinese";
	params.seed = 42;
	params.max_new_tokens = max_new_tokens;
}

bool synthesize_wav(qt_context * context, qt_tts_params & params, const std::filesystem::path & path,
	double & processing_ms, double & duration_ms) {
	qt_audio audio = {};
	const auto started = Clock::now();
	const qt_status status = qt_synthesize(context, &params, &audio);
	processing_ms = elapsed_ms(started);
	if (status != QT_STATUS_OK) {
		std::fprintf(stderr, "synthesis failed: %s\n", qt_last_error());
		return false;
	}
	duration_ms = audio.sample_rate > 0 ? 1000.0 * audio.n_samples / audio.sample_rate : 0.0;
	const bool written = audio_write_wav(path.string().c_str(), audio.samples, audio.n_samples, audio.sample_rate);
	qt_audio_free(&audio);
	return written;
}

} // namespace

int main(int argc, char ** argv) {
	Args args;
	if (!parse_args(argc, argv, args)) {
		std::fprintf(stderr,
			"usage: %s --model FILE --codec FILE --output-dir DIR [--ref-wav FILE --ref-text TEXT] "
			"[--max-new N]\n",
			argv[0]);
		return 2;
	}

	std::filesystem::create_directories(args.output_dir);
	qt_init_params init_params;
	qt_init_default_params(&init_params);
	init_params.talker_path = args.model;
	init_params.codec_path = args.codec;

	const auto load_started = Clock::now();
	qt_context * context = qt_init(&init_params);
	const double load_ms = elapsed_ms(load_started);
	if (!context) {
		std::fprintf(stderr, "model load failed: %s\n", qt_last_error());
		return 1;
	}

	const std::filesystem::path output_dir(args.output_dir);
	qt_tts_params buffered_params;
	configure_synthesis(buffered_params, "你好，这是 VoxSpeech 原生语音验证。", args.max_new_tokens);
	double buffered_ms = 0.0;
	double buffered_duration_ms = 0.0;
	if (!synthesize_wav(context, buffered_params, output_dir / "buffered.wav", buffered_ms,
		buffered_duration_ms)) {
		qt_free(context);
		return 1;
	}

	const std::filesystem::path pcm_path = output_dir / "stream.pcm";
	StreamState stream;
	stream.pcm = std::fopen(pcm_path.string().c_str(), "wb");
	if (!stream.pcm) {
		qt_free(context);
		return 1;
	}
	qt_tts_params stream_params;
	configure_synthesis(stream_params, "你好，这是 VoxSpeech 流式语音验证。", args.max_new_tokens);
	stream.started = Clock::now();
	stream_params.on_chunk = write_pcm_chunk;
	stream_params.on_chunk_user_data = &stream;
	const qt_status stream_status = qt_synthesize(context, &stream_params, nullptr);
	const double stream_ms = elapsed_ms(stream.started);
	std::fclose(stream.pcm);
	if (stream_status != QT_STATUS_OK || stream.chunks < 1 || stream.samples < 1) {
		std::fprintf(stderr, "streaming failed: %s\n", qt_last_error());
		qt_free(context);
		return 1;
	}

	CancelState cancel;
	qt_tts_params cancel_params;
	configure_synthesis(cancel_params, "这条较长的语音必须被合作式取消，不能完整生成。", args.max_new_tokens);
	cancel_params.cancel = cancel_after_first_poll;
	cancel_params.cancel_user_data = &cancel;
	qt_audio cancelled_audio = {};
	const qt_status cancel_status = qt_synthesize(context, &cancel_params, &cancelled_audio);
	qt_audio_free(&cancelled_audio);
	if (cancel_status != QT_STATUS_CANCELLED || cancel.polls < 1) {
		std::fprintf(stderr, "cancellation failed: status=%d error=%s\n", cancel_status, qt_last_error());
		qt_free(context);
		return 1;
	}

	bool reference_clone_verified = false;
	bool clone_latent_verified = false;
	int ref_spk_dim = 0;
	int ref_frames = 0;
	int ref_codebooks = 0;
	if (args.ref_wav) {
		int ref_samples = 0;
		float * ref_audio = audio_read_mono(args.ref_wav, 24000, &ref_samples);
		if (!ref_audio) {
			qt_free(context);
			return 1;
		}

		qt_tts_params reference_params;
		configure_synthesis(reference_params, "这段语音直接使用了参考音频。", args.max_new_tokens);
		reference_params.ref_audio_24k = ref_audio;
		reference_params.ref_n_samples = ref_samples;
		reference_params.ref_text = args.ref_text;
		double reference_ms = 0.0;
		double reference_duration_ms = 0.0;
		reference_clone_verified = synthesize_wav(context, reference_params, output_dir / "clone-reference.wav",
			reference_ms, reference_duration_ms);
		if (!reference_clone_verified) {
			std::free(ref_audio);
			qt_free(context);
			return 1;
		}

		qt_voice_ref voice_ref = {};
		const qt_status extract_status = qt_extract_voice_ref(context, ref_audio, ref_samples, &voice_ref);
		std::free(ref_audio);
		if (extract_status != QT_STATUS_OK) {
			std::fprintf(stderr, "voice extraction failed: %s\n", qt_last_error());
			qt_free(context);
			return 1;
		}
		ref_spk_dim = voice_ref.ref_spk_dim;
		ref_frames = voice_ref.ref_T;
		ref_codebooks = voice_ref.num_codebooks;

		qt_tts_params clone_params;
		configure_synthesis(clone_params, "这段语音复用了预先提取的参考音色。", args.max_new_tokens);
		clone_params.ref_spk_emb = voice_ref.ref_spk_emb;
		clone_params.ref_spk_dim = voice_ref.ref_spk_dim;
		clone_params.ref_codes = voice_ref.ref_codes;
		clone_params.ref_T = voice_ref.ref_T;
		clone_params.ref_text = args.ref_text;
		double clone_ms = 0.0;
		double clone_duration_ms = 0.0;
		clone_latent_verified = synthesize_wav(context, clone_params, output_dir / "clone-latent.wav", clone_ms,
			clone_duration_ms);
		qt_voice_ref_free(&voice_ref);
		if (!clone_latent_verified) {
			qt_free(context);
			return 1;
		}
	}

	qt_free(context);
	const double buffered_rtf = buffered_duration_ms > 0.0 ? buffered_ms / buffered_duration_ms : 0.0;
	std::printf(
		"{\"version\":\"%s\",\"loadMs\":%.2f,\"bufferedMs\":%.2f,\"bufferedDurationMs\":%.2f,"
		"\"bufferedRtf\":%.4f,\"streamMs\":%.2f,\"firstAudioMs\":%.2f,\"streamChunks\":%d,"
		"\"streamSamples\":%lld,\"cancelPolls\":%d,\"referenceCloneVerified\":%s,"
		"\"cloneLatentVerified\":%s,\"refSpkDim\":%d,\"refFrames\":%d,\"refCodebooks\":%d}\n",
		qt_version(), load_ms, buffered_ms, buffered_duration_ms, buffered_rtf, stream_ms, stream.first_audio_ms,
		stream.chunks, static_cast<long long>(stream.samples), cancel.polls,
		reference_clone_verified ? "true" : "false", clone_latent_verified ? "true" : "false", ref_spk_dim,
		ref_frames, ref_codebooks);
	return 0;
}
