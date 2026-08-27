# P1 qwentts.cpp native probe

This opt-in executable exercises the pinned qwentts.cpp public C ABI without
implementing the VoxSpeech JSON-RPC engine. It verifies:

- buffered WAV synthesis;
- streaming 24 kHz mono PCM16 with measured first-audio latency;
- cooperative cancellation;
- Base-model reference extraction and immediate latent reuse;
- normal context destruction and process exit.

## Fetch the pinned models

```bash
yarn model:download \
	native/engine/probe/model-manifest.json \
	--output-dir /tmp/voxspeech-p1-models
```

This helper (`native/engine/probe/download-models.ts`) pins exact revisions and
SHA-256 checksums via the manifest API of `@tinyaxis/model-downloader`. The
published package also ships a `model-downloader` CLI that discovers files from
a repository name directly.

The TypeScript downloader uses parallel HTTP Range requests, preserves completed
chunks across process restarts, and verifies both size and SHA256 before an atomic
install. Set `HF_ENDPOINT` or pass `--hub-url` for a Hugging Face-compatible mirror.
It honors `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY`; `--proxy` explicitly overrides
the environment for this command.

```bash
HF_ENDPOINT=https://hf-mirror.example \
	yarn model:download \
	native/engine/probe/model-manifest.json \
	--output-dir /tmp/voxspeech-p1-models \
	--connections 8
```

## CPU build and run

```bash
cmake -S native/third_party/qwentts.cpp -B /tmp/voxspeech-qwentts-cpu -G Ninja \
	-DCMAKE_BUILD_TYPE=Release \
	-DGGML_NATIVE=ON \
	-DGGML_CUDA=OFF \
	-DCMAKE_PROJECT_INCLUDE="$PWD/native/engine/probe/inject.cmake"
cmake --build /tmp/voxspeech-qwentts-cpu --target voxspeech-native-probe test-abi-c
/tmp/voxspeech-qwentts-cpu/voxspeech-probe/voxspeech-native-probe \
	--model /tmp/voxspeech-p1-models/qwen-talker-1.7b-base-Q4_K_M.gguf \
	--codec /tmp/voxspeech-p1-models/qwen-tokenizer-12hz-Q4_K_M.gguf \
	--ref-wav native/third_party/qwentts.cpp/examples/freeman.wav \
	--ref-text "This is the voice of the great Freeman." \
	--output-dir /tmp/voxspeech-p1-probe
```

## CUDA build

Use the same commands with `-DGGML_CUDA=ON`, `-DGGML_CUDA_NCCL=OFF`,
`-DGGML_STATIC=ON`, `-DBUILD_SHARED_LIBS=OFF`, and
`-DCMAKE_CUDA_ARCHITECTURES=native`. A CUDA toolkit containing `nvcc` is a
build-time prerequisite only. `GGML_STATIC=ON` is distinct from
`BUILD_SHARED_LIBS=OFF`: both are required for a probe that does not dynamically
link the CUDA runtime and cuBLAS.

The P1 machine uses CUDA 13.3 with GCC 15 explicitly selected as the CUDA host
compiler. A release artifact must replace `native` with its supported architecture
matrix; the P1 binary targets only the local Blackwell `120a` GPU.

## Vulkan build

Use the CPU commands with `-DGGML_VULKAN=ON`, `-DGGML_CUDA=OFF`,
`-DGGML_STATIC=ON`, and `-DBUILD_SHARED_LIBS=OFF`. Vulkan headers and a shader
compiler are build-time prerequisites. The resulting executable embeds its shaders
and dynamically links only the Vulkan loader. When several devices are present,
select one explicitly for repeatable measurements:

```bash
GGML_BACKEND=Vulkan0 \
	/tmp/voxspeech-qwentts-vulkan-static/voxspeech-probe/voxspeech-native-probe \
	--model /tmp/voxspeech-p1-models/qwen-talker-1.7b-base-Q4_K_M.gguf \
	--codec /tmp/voxspeech-p1-models/qwen-tokenizer-12hz-Q4_K_M.gguf \
	--ref-wav native/third_party/qwentts.cpp/examples/freeman.wav \
	--ref-text "This is the voice of the great Freeman." \
	--output-dir /tmp/voxspeech-p1-probe-vulkan
```

The first process on a new NVIDIA driver cache may spend several seconds creating
shader pipelines. Benchmark a second process for steady-state performance, while
recording the first run separately as product warm-up cost.

The `CMAKE_PROJECT_INCLUDE` overlay adds only the probe target after upstream
has declared `qwen-core`; the qwentts.cpp submodule remains unmodified.

Probe metrics are printed as one JSON object after `qt_free`. They are evidence
for the current machine only and are not release performance promises.
