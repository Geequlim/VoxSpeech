#include "voxspeech/engine/voice_reference.hpp"

#include <bit>
#include <cerrno>
#include <climits>
#include <cstddef>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <limits>
#include <system_error>

#include <fcntl.h>
#include <unistd.h>

namespace voxspeech::engine {
namespace {

constexpr std::uint64_t bitsPerCode = 11;

std::expected<std::vector<std::uint8_t>, std::string> readBytes(const std::string& path)
{
	std::error_code error;
	const auto status = std::filesystem::status(path, error);
	if (error || !std::filesystem::is_regular_file(status)) {
		return std::unexpected{"reference path is not a readable regular file: " + path};
	}
	const auto size = std::filesystem::file_size(path, error);
	if (error || size == 0 || size > static_cast<std::uintmax_t>(std::numeric_limits<std::size_t>::max())) {
		return std::unexpected{"reference file has an invalid size: " + path};
	}
	std::vector<std::uint8_t> bytes(static_cast<std::size_t>(size));
	std::ifstream input{path, std::ios::binary};
	if (!input || !input.read(reinterpret_cast<char*>(bytes.data()), static_cast<std::streamsize>(bytes.size()))) {
		return std::unexpected{"failed to read reference file: " + path};
	}
	return bytes;
}

std::expected<void, std::string> writeNewFile(const std::string& path, const std::span<const std::uint8_t> bytes)
{
	const int descriptor = ::open(path.c_str(), O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC, 0600);
	if (descriptor < 0) {
		return std::unexpected{"failed to create reference output: " + path + ": " + std::strerror(errno)};
	}
	std::size_t offset = 0;
	while (offset < bytes.size()) {
		ssize_t written = 0;
		do {
			written = ::write(descriptor, bytes.data() + offset, bytes.size() - offset);
		} while (written < 0 && errno == EINTR);
		if (written <= 0) {
			const std::string details = std::strerror(errno);
			::close(descriptor);
			std::filesystem::remove(path);
			return std::unexpected{"failed to write reference output: " + path + ": " + details};
		}
		offset += static_cast<std::size_t>(written);
	}
	if (::close(descriptor) != 0) {
		std::filesystem::remove(path);
		return std::unexpected{"failed to close reference output: " + path};
	}
	return {};
}

} // namespace

std::expected<std::vector<std::uint8_t>, std::string> packVoiceCodes(
	const std::span<const std::int32_t> codes)
{
	if (codes.empty() || codes.size() > std::numeric_limits<std::size_t>::max() / bitsPerCode) {
		return std::unexpected{"voice codes are empty or too large"};
	}
	const auto bitCount = codes.size() * bitsPerCode;
	std::vector<std::uint8_t> packed((bitCount + CHAR_BIT - 1) / CHAR_BIT, 0);
	std::size_t bitOffset = 0;
	for (const auto code : codes) {
		if (code < 0 || code > 0x7ff) {
			return std::unexpected{"voice code is outside the 11-bit range"};
		}
		for (std::size_t bit = 0; bit < bitsPerCode; ++bit) {
			if ((static_cast<std::uint32_t>(code) & (1U << bit)) != 0) {
				packed[(bitOffset + bit) / CHAR_BIT] |= static_cast<std::uint8_t>(1U << ((bitOffset + bit) % CHAR_BIT));
			}
		}
		bitOffset += bitsPerCode;
	}
	return packed;
}

VoiceReferenceOutcome readVoiceReference(
	const std::string& speakerPath,
	const std::string& codesPath,
	const std::uint64_t codebookCount)
{
	static_assert(std::endian::native == std::endian::little);
	if (codebookCount == 0) {
		return std::unexpected{"loaded codec reported no codebooks"};
	}
	auto speakerBytes = readBytes(speakerPath);
	if (!speakerBytes) {
		return std::unexpected{speakerBytes.error()};
	}
	if (speakerBytes->size() % sizeof(float) != 0 || speakerBytes->size() / sizeof(float) > INT_MAX) {
		return std::unexpected{"speaker reference is not a valid float32 array"};
	}
	auto codeBytes = readBytes(codesPath);
	if (!codeBytes) {
		return std::unexpected{codeBytes.error()};
	}
	if (codeBytes->size() > std::numeric_limits<std::size_t>::max() / CHAR_BIT) {
		return std::unexpected{"voice code reference is too large"};
	}
	const auto availableCodes = codeBytes->size() * CHAR_BIT / bitsPerCode;
	const auto frameCount = availableCodes / codebookCount;
	if (frameCount == 0 || frameCount > INT_MAX || frameCount > std::numeric_limits<std::size_t>::max() / codebookCount) {
		return std::unexpected{"voice code reference has no valid frames"};
	}
	const auto codeCount = static_cast<std::size_t>(frameCount * codebookCount);
	const auto usedBits = codeCount * bitsPerCode;
	if ((usedBits + CHAR_BIT - 1) / CHAR_BIT != codeBytes->size()) {
		return std::unexpected{"voice code reference size does not match its codebook layout"};
	}
	for (std::size_t bit = usedBits; bit < codeBytes->size() * CHAR_BIT; ++bit) {
		if (((*codeBytes)[bit / CHAR_BIT] & (1U << (bit % CHAR_BIT))) != 0) {
			return std::unexpected{"voice code reference has non-zero padding bits"};
		}
	}

	VoiceReferenceData reference;
	reference.speaker.resize(speakerBytes->size() / sizeof(float));
	std::memcpy(reference.speaker.data(), speakerBytes->data(), speakerBytes->size());
	reference.codes.resize(codeCount);
	for (std::size_t index = 0, bitOffset = 0; index < codeCount; ++index, bitOffset += bitsPerCode) {
		std::uint32_t code = 0;
		for (std::size_t bit = 0; bit < bitsPerCode; ++bit) {
			if (((*codeBytes)[(bitOffset + bit) / CHAR_BIT] & (1U << ((bitOffset + bit) % CHAR_BIT))) != 0) {
				code |= 1U << bit;
			}
		}
		reference.codes[index] = static_cast<std::int32_t>(code);
	}
	reference.frameCount = frameCount;
	return reference;
}

std::expected<void, std::string> writeVoiceReference(
	const std::string& speakerPath,
	const std::string& codesPath,
	const std::span<const float> speaker,
	const std::span<const std::int32_t> codes)
{
	static_assert(std::endian::native == std::endian::little);
	if (speaker.empty()) {
		return std::unexpected{"speaker reference is empty"};
	}
	auto packed = packVoiceCodes(codes);
	if (!packed) {
		return std::unexpected{packed.error()};
	}
	const auto speakerBytes = std::as_bytes(speaker);
	auto speakerWrite = writeNewFile(
		speakerPath,
		{reinterpret_cast<const std::uint8_t*>(speakerBytes.data()), speakerBytes.size()});
	if (!speakerWrite) {
		return speakerWrite;
	}
	auto codesWrite = writeNewFile(codesPath, *packed);
	if (!codesWrite) {
		std::filesystem::remove(speakerPath);
		return codesWrite;
	}
	return {};
}

} // namespace voxspeech::engine
