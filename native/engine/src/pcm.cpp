#include "voxspeech/engine/pcm.hpp"

#include <cmath>
#include <cstdint>

namespace voxspeech::engine {
namespace {

constexpr std::uint8_t base64Alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

int base64Value(const char c)
{
	if (c >= 'A' && c <= 'Z') {
		return c - 'A';
	}
	if (c >= 'a' && c <= 'z') {
		return c - 'a' + 26;
	}
	if (c >= '0' && c <= '9') {
		return c - '0' + 52;
	}
	if (c == '+') {
		return 62;
	}
	if (c == '/') {
		return 63;
	}
	return -1;
}

} // namespace

std::vector<std::uint8_t> floatsToPcm16Le(const std::span<const float> samples)
{
	std::vector<std::uint8_t> bytes;
	bytes.reserve(samples.size() * 2);
	for (float sample : samples) {
		if (std::isnan(sample)) {
			sample = 0.0F;
		}
		else if (sample > 1.0F) {
			sample = 1.0F;
		}
		else if (sample < -1.0F) {
			sample = -1.0F;
		}
		const auto value = static_cast<std::int16_t>(std::lrint(sample * 32767.0F));
		const auto bits = static_cast<std::uint16_t>(value);
		bytes.push_back(static_cast<std::uint8_t>(bits & 0xFFU));
		bytes.push_back(static_cast<std::uint8_t>(bits >> 8U));
	}
	return bytes;
}

std::string base64Encode(const std::span<const std::uint8_t> bytes)
{
	std::string text;
	text.reserve((bytes.size() + 2) / 3 * 4);
	std::size_t index = 0;
	while (index + 3 <= bytes.size()) {
		const std::uint32_t triple = static_cast<std::uint32_t>(bytes[index]) << 16U |
			static_cast<std::uint32_t>(bytes[index + 1]) << 8U | static_cast<std::uint32_t>(bytes[index + 2]);
		text.push_back(base64Alphabet[(triple >> 18U) & 0x3FU]);
		text.push_back(base64Alphabet[(triple >> 12U) & 0x3FU]);
		text.push_back(base64Alphabet[(triple >> 6U) & 0x3FU]);
		text.push_back(base64Alphabet[triple & 0x3FU]);
		index += 3;
	}
	const std::size_t remaining = bytes.size() - index;
	if (remaining == 1) {
		const std::uint32_t triple = static_cast<std::uint32_t>(bytes[index]) << 16U;
		text.push_back(base64Alphabet[(triple >> 18U) & 0x3FU]);
		text.push_back(base64Alphabet[(triple >> 12U) & 0x3FU]);
		text.append("==");
	}
	else if (remaining == 2) {
		const std::uint32_t triple =
			static_cast<std::uint32_t>(bytes[index]) << 16U | static_cast<std::uint32_t>(bytes[index + 1]) << 8U;
		text.push_back(base64Alphabet[(triple >> 18U) & 0x3FU]);
		text.push_back(base64Alphabet[(triple >> 12U) & 0x3FU]);
		text.push_back(base64Alphabet[(triple >> 6U) & 0x3FU]);
		text.push_back('=');
	}
	return text;
}

bool base64Decode(const std::string_view text, std::vector<std::uint8_t>& out)
{
	if (text.size() % 4 != 0) {
		return false;
	}
	out.clear();
	out.reserve(text.size() / 4 * 3);
	std::uint32_t accumulator = 0;
	int bits = 0;
	std::size_t index = 0;
	for (; index < text.size(); ++index) {
		const char c = text[index];
		if (c == '=') {
			break;
		}
		const int value = base64Value(c);
		if (value < 0) {
			return false;
		}
		accumulator = (accumulator << 6U) | static_cast<std::uint32_t>(value);
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push_back(static_cast<std::uint8_t>((accumulator >> bits) & 0xFFU));
		}
	}
	const std::size_t padding = text.size() - index;
	if (padding > 2) {
		return false;
	}
	for (std::size_t pad = 0; pad < padding; ++pad) {
		if (text[index + pad] != '=') {
			return false;
		}
	}
	const std::size_t expected = text.size() / 4 * 3 - padding;
	return out.size() == expected;
}

} // namespace voxspeech::engine
