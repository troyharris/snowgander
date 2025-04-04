import { AnthropicAdapter } from "../anthropic";
import {
  VendorConfig,
  ModelConfig,
  AIRequestOptions,
  Message,
  TextBlock,
  ImageDataBlock,
  AIResponse,
  UsageResponse,
  Chat,
  ImageBlock,
  ThinkingBlock, // Import ThinkingBlock
  ChatResponse,
} from "../../types";
import Anthropic from "@anthropic-ai/sdk";
import { computeResponseCost } from "../../utils";

// Mock the Anthropic SDK
const mockMessagesCreate = jest.fn();
jest.mock("@anthropic-ai/sdk", () => {
  return jest.fn().mockImplementation(() => ({
    messages: {
      create: mockMessagesCreate,
    },
  }));
});

// Helper to get mock constructor and methods
const getMockAnthropicClient = () => {
  const MockAnthropicConstructor = Anthropic as unknown as jest.Mock;
  const mockClientInstance = MockAnthropicConstructor.mock.instances[0];
  return {
    mockMessagesCreate, // Return the original mock function
    MockAnthropicConstructor,
  };
};

describe("AnthropicAdapter", () => {
  let adapter: AnthropicAdapter;
  const mockConfig: VendorConfig = { apiKey: "test-anthropic-key" };
  const mockClaude3Opus: ModelConfig = {
    apiName: "claude-3-opus-20240229",
    isVision: true,
    isImageGeneration: false,
    isThinking: true, // Claude 3 supports thinking blocks
    inputTokenCost: 15 / 1_000_000,
    outputTokenCost: 75 / 1_000_000,
  };
  const mockClaude3Sonnet: ModelConfig = {
    apiName: "claude-3-sonnet-20240229",
    isVision: true,
    isImageGeneration: false,
    isThinking: true,
    inputTokenCost: 3 / 1_000_000,
    outputTokenCost: 15 / 1_000_000,
  };

  beforeEach(() => {
    jest.clearAllMocks();
    // Create adapter with Opus model by default
    adapter = new AnthropicAdapter(mockConfig, mockClaude3Opus);
    // Verify constructor call
    const { MockAnthropicConstructor } = getMockAnthropicClient();
    expect(MockAnthropicConstructor).toHaveBeenCalledWith({
      apiKey: mockConfig.apiKey,
      baseURL: mockConfig.baseURL, // Will be undefined
    });
  });

  it("should initialize Anthropic client with correct config", () => {
    const { MockAnthropicConstructor } = getMockAnthropicClient();
    expect(MockAnthropicConstructor).toHaveBeenCalledTimes(1);
    expect(MockAnthropicConstructor).toHaveBeenCalledWith({
      apiKey: mockConfig.apiKey,
      baseURL: undefined,
    });
  });

  it("should reflect capabilities from ModelConfig", () => {
    expect(adapter.isVisionCapable).toBe(true);
    expect(adapter.isImageGenerationCapable).toBe(false);
    expect(adapter.isThinkingCapable).toBe(true); // Check thinking capability
    expect(adapter.inputTokenCost).toBe(mockClaude3Opus.inputTokenCost);
    expect(adapter.outputTokenCost).toBe(mockClaude3Opus.outputTokenCost);
  });

  // --- generateResponse Tests ---
  describe("generateResponse", () => {
    const basicMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello Claude!" }] },
    ];
    const basicOptions: AIRequestOptions = {
      model: mockClaude3Opus.apiName,
      messages: basicMessages,
    };

    it("should call Anthropic messages.create with correct basic parameters", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const mockApiResponse = {
        // Structure based on Anthropic SDK examples
        id: "msg_123",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Hi there!" }],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 5 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      await adapter.generateResponse(basicOptions);

      expect(mockMessagesCreate).toHaveBeenCalledTimes(1);
      expect(mockMessagesCreate).toHaveBeenCalledWith({
        model: mockClaude3Opus.apiName,
        messages: [
          // Expect content as array
          { role: "user", content: [{ type: "text", text: "Hello Claude!" }] },
        ],
        system: undefined, // No system prompt in basicOptions
        max_tokens: 1024, // Expect the default value used by the adapter
        temperature: undefined,
      });
    });

    it("should map Anthropic response to AIResponse format including calculated usage", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const mockApiResponse = {
        id: "msg_abc",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Response from Anthropic." }],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 25, output_tokens: 15 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      const response = await adapter.generateResponse(basicOptions);

      const expectedInputCost = computeResponseCost(
        mockApiResponse.usage.input_tokens,
        adapter.inputTokenCost!
      );
      const expectedOutputCost = computeResponseCost(
        mockApiResponse.usage.output_tokens,
        adapter.outputTokenCost!
      );
      const expectedTotalCost = expectedInputCost + expectedOutputCost;

      expect(response).toEqual<AIResponse>({
        role: "assistant",
        content: [{ type: "text", text: "Response from Anthropic." }],
        usage: {
          inputCost: expectedInputCost,
          outputCost: expectedOutputCost,
          totalCost: expectedTotalCost,
        },
      });
    });

    it("should handle system prompt", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const systemPrompt = "You are Claude.";
      const optionsWithSystem: AIRequestOptions = {
        ...basicOptions,
        systemPrompt,
      };
      const mockApiResponse = {
        // Basic response structure
        id: "msg_sys",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Yes?" }],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        usage: { input_tokens: 5, output_tokens: 1 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      await adapter.generateResponse(optionsWithSystem);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          system: systemPrompt, // Verify system prompt mapping
          messages: [
            // Expect content as array
            {
              role: "user",
              content: [{ type: "text", text: "Hello Claude!" }],
            },
          ],
        })
      );
    });

    it("should IGNORE ImageDataBlock (as mapping is not implemented)", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const imageData: ImageDataBlock = {
        type: "image_data",
        mimeType: "image/jpeg",
        base64Data: "base64jpegstring",
      };
      const messagesWithImage: Message[] = [
        {
          role: "user",
          content: [imageData, { type: "text", text: "What is in this JPEG?" }],
        },
      ];
      const optionsWithImage: AIRequestOptions = {
        ...basicOptions,
        messages: messagesWithImage,
      };
      const mockApiResponse = {
        // Basic response structure
        id: "msg_img",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "A JPEG image." }],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 5 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      await adapter.generateResponse(optionsWithImage);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: [
                // Image block should be filtered out by the adapter's current logic
                { type: "text", text: "What is in this JPEG?" },
              ],
            },
          ],
        })
      );
    });

    it("should IGNORE ImageBlock (URL) (as mapping is not implemented)", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const imageBlock: ImageBlock = {
        type: "image",
        url: "http://example.com/image.png",
      };
      const messagesWithImage: Message[] = [
        {
          role: "user",
          content: [
            imageBlock,
            { type: "text", text: "What is in this image URL?" },
          ],
        },
      ];
      const optionsWithImage: AIRequestOptions = {
        ...basicOptions,
        messages: messagesWithImage,
      };
      const mockApiResponse = {
        // Basic response structure
        id: "msg_img_url",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "An image URL." }],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 5 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      await adapter.generateResponse(optionsWithImage);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: [
                // Image block should be filtered out
                { type: "text", text: "What is in this image URL?" },
              ],
            },
          ],
        })
      );
    });

    // Add tests for ThinkingBlock input/output
    it("should map ThinkingBlock input correctly", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const thinkingBlock: ThinkingBlock = {
        type: "thinking",
        thinking: "Let me think...",
        signature: "test-sig",
      };
      const messagesWithThinking: Message[] = [
        { role: "user", content: [thinkingBlock] }, // Assuming thinking can be sent by user? Check adapter logic. Adapter maps it.
      ];
      const optionsWithThinking: AIRequestOptions = {
        ...basicOptions,
        messages: messagesWithThinking,
      };
      const mockApiResponse = {
        // Basic response structure
        id: "msg_think_in",
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Okay, I thought." }],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        usage: { input_tokens: 50, output_tokens: 5 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      await adapter.generateResponse(optionsWithThinking);

      expect(mockMessagesCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          messages: [
            {
              role: "user",
              content: [
                // Expect mapped thinking block
                {
                  type: "thinking",
                  thinking: "Let me think...",
                  signature: "test-sig",
                },
              ],
            },
          ],
        })
      );
    });

    it("should map ThinkingBlock output correctly", async () => {
      const { mockMessagesCreate } = getMockAnthropicClient();
      const mockApiResponse = {
        id: "msg_think_out",
        type: "message",
        role: "assistant",
        content: [
          // Response includes thinking and text
          {
            type: "thinking",
            thinking: "Assistant is thinking...",
            signature: "anthropic",
          }, // Anthropic SDK might not have signature here, adapter adds it
          { type: "text", text: "Here is the result." },
        ],
        model: mockClaude3Opus.apiName,
        stop_reason: "end_turn",
        usage: { input_tokens: 25, output_tokens: 15 },
      };
      mockMessagesCreate.mockResolvedValue(mockApiResponse);

      const response = await adapter.generateResponse(basicOptions); // Basic options are fine, response content matters

      expect(response.content).toEqual([
        // Remove explicit type assertion
        {
          type: "thinking",
          thinking: "Assistant is thinking...",
          signature: "anthropic",
        }, // Expect mapped thinking block
        { type: "text", text: "Here is the result." },
      ]);
    });

    // Add tests for API errors
  });

  // --- sendChat Tests ---
  describe("sendChat", () => {
    let generateResponseSpy: jest.SpyInstance;
    const baseChat: Partial<Chat> = {
      // Use Partial for easier test setup
      model: mockClaude3Opus.apiName,
      responseHistory: [],
      personaId: 1,
      outputFormatId: 1,
      renderTypeName: "text",
      visionUrl: null,
      modelId: 1,
      prompt: "User prompt",
      imageURL: null,
      maxTokens: 100,
      budgetTokens: null, // Thinking disabled by default
      personaPrompt: "System prompt",
    };

    beforeEach(() => {
      // Mock the instance's generateResponse method before each sendChat test
      generateResponseSpy = jest
        .spyOn(adapter, "generateResponse")
        .mockResolvedValue({
          role: "assistant",
          content: [{ type: "text", text: "Mocked chat response" }],
          usage: { inputCost: 0.015, outputCost: 0.075, totalCost: 0.09 }, // Example usage
        });
    });

    afterEach(() => {
      // Restore the original implementation after each test
      generateResponseSpy.mockRestore();
    });

    it("should call generateResponse with mapped messages and options (thinking disabled)", async () => {
      const chatWithHistory: Chat = {
        ...baseChat,
        responseHistory: [
          {
            role: "user",
            content: [{ type: "text", text: "Previous question" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Previous answer" }],
          },
        ],
        prompt: "Current question",
      } as Chat;

      await adapter.sendChat(chatWithHistory);

      expect(generateResponseSpy).toHaveBeenCalledTimes(1);
      expect(generateResponseSpy).toHaveBeenCalledWith({
        model: chatWithHistory.model,
        messages: [
          // Expect history + current prompt (as user message)
          {
            role: "user",
            content: [{ type: "text", text: "Previous question" }],
          },
          {
            role: "assistant",
            content: [{ type: "text", text: "Previous answer" }],
          },
          {
            role: "user",
            content: [{ type: "text", text: "Current question" }],
          },
        ],
        maxTokens: chatWithHistory.maxTokens,
        budgetTokens: undefined, // Thinking disabled
        systemPrompt: chatWithHistory.personaPrompt,
        thinkingMode: false, // Explicitly false when budgetTokens is null/0
      });
    });

    it("should enable thinkingMode and pass budgetTokens if budgetTokens > 0", async () => {
      const chatWithThinking: Chat = {
        ...baseChat,
        budgetTokens: 500, // Enable thinking
        prompt: "Think about this",
      } as Chat;

      await adapter.sendChat(chatWithThinking);

      expect(generateResponseSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          thinkingMode: true,
          budgetTokens: 500,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Think about this" }],
            },
          ],
        })
      );
    });

    it("should return the ChatResponse with content and usage from generateResponse", async () => {
      const chat: Chat = baseChat as Chat;
      const expectedUsage: UsageResponse = {
        inputCost: 0.015,
        outputCost: 0.075,
        totalCost: 0.09,
      };
      // Ensure the spy returns the expected usage
      generateResponseSpy.mockResolvedValue({
        role: "assistant",
        content: [{ type: "text", text: "Specific chat response" }],
        usage: expectedUsage,
      });

      const result = await adapter.sendChat(chat);

      expect(result).toEqual<ChatResponse>({
        role: "assistant",
        content: [{ type: "text", text: "Specific chat response" }],
        usage: expectedUsage, // Verify usage is passed through
      });
    });

    // Note: Anthropic adapter doesn't handle visionUrl in sendChat, generateResponse handles it if passed in messages
  });

  // --- generateImage Tests ---
  describe("generateImage", () => {
    it("should throw NotImplementedError", async () => {
      const dummyChat: Partial<Chat> = { prompt: "test" };
      await expect(adapter.generateImage(dummyChat as Chat)).rejects.toThrow(
        "Image generation not supported by Anthropic" // Match exact error message
      );
    });
  });

  // --- sendMCPChat Tests ---
  describe("sendMCPChat", () => {
    it("should throw NotImplementedError", async () => {
      const dummyChat: Partial<Chat> = { prompt: "test" };
      const dummyTool: any = { id: 1, name: "dummy", path: "" };
      try {
        await adapter.sendMCPChat(dummyChat as Chat, dummyTool);
        // If it doesn't throw, fail the test
        throw new Error("sendMCPChat did not throw the expected error.");
      } catch (error: any) {
        // Assert on the error message directly
        expect(error.message).toBe(
          "Direct MCP tool execution is not handled within the AIVendorAdapter. The calling application must manage tool definition, execution, and result submission."
        );
      }
    });
  });
});
