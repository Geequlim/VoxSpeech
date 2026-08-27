#include "voxspeech/engine/voice_reference.hpp"

#include <bit>
#include <cassert>
#include <cstdint>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

#include <unistd.h>

int main()
{
	static_assert(std::endian::native == std::endian::little);
	const auto directory = std::filesystem::temp_directory_path() /
		("voxspeech-voice-reference-" + std::to_string(::getpid()));
	std::filesystem::remove_all(directory);
	std::filesystem::create_directories(directory);
	const auto speakerPath = (directory / "voice.spk").string();
	const auto codesPath = (directory / "voice.rvq").string();
	const std::vector<float> speaker{0.25F, -0.5F, 1.0F};
	const std::vector<std::int32_t> codes{0, 1, 2047, 17, 42, 1024};

	const auto written = voxspeech::engine::writeVoiceReference(
		speakerPath, codesPath, speaker, codes);
	assert(written.has_value());
	const auto loaded = voxspeech::engine::readVoiceReference(speakerPath, codesPath, 2);
	assert(loaded.has_value());
	assert(loaded->speaker == speaker);
	assert(loaded->codes == codes);
	assert(loaded->frameCount == 3);

	{
		std::fstream output{codesPath, std::ios::binary | std::ios::in | std::ios::out};
		output.seekg(-1, std::ios::end);
		char tail{};
		output.read(&tail, 1);
		output.clear();
		output.seekp(-1, std::ios::end);
		tail = static_cast<char>(static_cast<unsigned char>(tail) | 0x80U);
		output.write(&tail, 1);
	}
	assert(!voxspeech::engine::readVoiceReference(speakerPath, codesPath, 2).has_value());
	assert(!voxspeech::engine::packVoiceCodes(std::vector<std::int32_t>{2048}).has_value());

	std::filesystem::remove_all(directory);
	return 0;
}
