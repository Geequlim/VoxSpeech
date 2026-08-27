#pragma once

#include <cstdint>
#include <expected>
#include <span>
#include <string>
#include <vector>

namespace voxspeech::engine {

struct VoiceReferenceData {
	std::vector<float> speaker;
	std::vector<std::int32_t> codes;
	std::uint64_t frameCount{};
};

using VoiceReferenceOutcome = std::expected<VoiceReferenceData, std::string>;

[[nodiscard]] std::expected<std::vector<std::uint8_t>, std::string> packVoiceCodes(
	std::span<const std::int32_t> codes);
[[nodiscard]] VoiceReferenceOutcome readVoiceReference(
	const std::string& speakerPath,
	const std::string& codesPath,
	std::uint64_t codebookCount);
[[nodiscard]] std::expected<void, std::string> writeVoiceReference(
	const std::string& speakerPath,
	const std::string& codesPath,
	std::span<const float> speaker,
	std::span<const std::int32_t> codes);

} // namespace voxspeech::engine
