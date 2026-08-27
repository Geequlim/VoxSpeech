#pragma once

#include <cstddef>
#include <iosfwd>
#include <string>
#include <string_view>
#include <vector>

#include "voxspeech/engine/protocol.hpp"

namespace voxspeech::engine {

enum class FrameError {
	none,
	message_too_large,
};

struct FrameBatch {
	std::vector<std::string> messages;
	FrameError error{FrameError::none};
};

class NdjsonDecoder {
public:
	explicit NdjsonDecoder(std::size_t maxMessageSize = protocol::max_message_size);

	[[nodiscard]] FrameBatch push(std::string_view bytes);
	[[nodiscard]] bool failed() const noexcept;
	[[nodiscard]] std::size_t bufferedSize() const noexcept;

private:
	std::size_t maxMessageSize_;
	std::string buffer_;
	bool failed_{false};
};

class OutputChannels {
public:
	OutputChannels(std::ostream& protocolOutput, std::ostream& logOutput);

	[[nodiscard]] bool writeProtocol(std::string_view json);
	void writeLog(std::string_view message);

private:
	std::ostream& protocolOutput_;
	std::ostream& logOutput_;
};

} // namespace voxspeech::engine
