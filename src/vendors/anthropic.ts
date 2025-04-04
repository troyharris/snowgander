import Anthropic from "@anthropic-ai/sdk";
import {
  AIVendorAdapter,
  AIRequestOptions,
  AIResponse,
  VendorConfig,
  ModelConfig,
  Chat,
  ChatResponse,
  ContentBlock,
  ToolUseBlock, // Import ToolUseBlock
  MCPTool,
  UsageResponse,
} from "../types";
import { computeResponseCost } from "../utils";
import { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages"; // Corrected Import Anthropic Tool type
// Removed Prisma Model import
// Removed incorrect Chat, ChatResponse, ContentBlock import path
// Removed application-specific imports (updateUserUsage, getCurrentAPIUser)

export class AnthropicAdapter implements AIVendorAdapter {
  private client: Anthropic;
  public isVisionCapable: boolean;
  public isImageGenerationCapable: boolean;
  public isThinkingCapable: boolean;
  public inputTokenCost?: number | undefined;
  public outputTokenCost?: number | undefined;

  // Constructor now accepts ModelConfig instead of Prisma Model
  constructor(config: VendorConfig, modelConfig: ModelConfig) {
    this.client = new Anthropic({
      apiKey: config.apiKey,
      baseURL: config.baseURL, // Allow overriding base URL
    });

    // Use fields from modelConfig
    this.isVisionCapable = modelConfig.isVision;
    this.isImageGenerationCapable = modelConfig.isImageGeneration;
    this.isThinkingCapable = modelConfig.isThinking;

    if (modelConfig.inputTokenCost && modelConfig.outputTokenCost) {
      this.inputTokenCost = modelConfig.inputTokenCost;
      this.outputTokenCost = modelConfig.outputTokenCost;
    }
  }

  async generateResponse(options: AIRequestOptions): Promise<AIResponse> {
    // Removed user fetching logic
    const {
      model,
      messages,
      maxTokens,
      budgetTokens,
      systemPrompt,
      thinkingMode,
      tools, // Destructure tools from options
    } = options;

    // Convert messages to Anthropic format
    // Convert messages to Anthropic format with inferred types
    const formattedMessages = messages.map((msg) => {
      const role =
        msg.role === "assistant" ? ("assistant" as const) : ("user" as const);

      if (typeof msg.content === "string") {
        return { role, content: msg.content };
      }

      // Map our content blocks to Anthropic's ContentBlockParam format
      const mappedContent = msg.content.reduce<
        Array<
          | {
              type: "text";
              text: string;
            }
          | {
              type: "thinking";
              thinking: string;
              signature: string;
            }
        >
      >((acc, block) => {
        if (block.type === "text") {
          acc.push({
            type: "text",
            text: block.text,
          });
        } else if (block.type === "thinking") {
          acc.push({
            type: "thinking",
            thinking: block.thinking,
            signature: block.signature,
          });
        }
        return acc;
      }, []);

      // If we have no valid content blocks, convert to a text block with the stringified content
      return {
        role,
        content:
          mappedContent.length > 0
            ? mappedContent
            : JSON.stringify(msg.content),
      };
    });

    const response = await this.client.messages.create({
      model,
      messages: formattedMessages,
      system: systemPrompt,
      max_tokens: maxTokens || 1024, // Default to 1024 if maxTokens is undefined
      ...(thinkingMode &&
        this.isThinkingCapable && {
          thinking: {
            type: "enabled",
            budget_tokens: budgetTokens || Math.floor((maxTokens || 1024) / 2), // Use provided budget or half of max tokens
          },
        }),
      ...(tools && { tools }), // Pass tools if provided
    });

    let usage: UsageResponse | undefined = undefined;

    if (
      response.usage.input_tokens &&
      response.usage.output_tokens &&
      this.inputTokenCost &&
      this.outputTokenCost
    ) {
      const inputCost = computeResponseCost(
        response.usage.input_tokens,
        this.inputTokenCost
      );
      const outputCost = computeResponseCost(
        response.usage.output_tokens,
        this.outputTokenCost
      );
      usage = {
        inputCost: inputCost,
        outputCost: outputCost,
        totalCost: inputCost + outputCost,
      };
    }

    // Convert Anthropic response blocks to our ContentBlock format
    const contentBlocks: ContentBlock[] = [];

    for (const block of response.content) {
      if (block.type === "thinking") {
        contentBlocks.push({
          type: "thinking",
          thinking: block.thinking,
          signature: "anthropic",
        });
      } else if (block.type === "text") {
        contentBlocks.push({
          type: "text",
          text: block.text,
        });
      } else if (block.type === "tool_use") {
        // Map Anthropic tool_use to our ToolUseBlock
        contentBlocks.push({
          type: "tool_use",
          name: block.name,
          input: JSON.stringify(block.input), // Stringify the input object
        });
      }
      // Skip any other unknown block types
    }

    // Removed usage calculation and user update logic
    // The calling application should handle cost calculation.
    // const usage = response.usage; // Could potentially return usage if needed

    return {
      role: "assistant",
      content: contentBlocks,
      usage: usage,
    };
  }

  async generateImage(chat: Chat): Promise<string> {
    throw new Error("Image generation not supported by Anthropic");
  }

  async sendChat(chat: Chat): Promise<ChatResponse> {
    // Combine history with the current prompt
    const messagesToSend = [...chat.responseHistory]; // Copy history
    if (chat.prompt) {
      messagesToSend.push({
        role: "user",
        content: [{ type: "text", text: chat.prompt }], // Add current prompt as user message
      });
    }

    // Format MCP tools for Anthropic API if available
    let formattedTools: AnthropicTool[] | undefined = undefined;
    if (chat.mcpAvailableTools && chat.mcpAvailableTools.length > 0) {
      formattedTools = chat.mcpAvailableTools.map((tool): AnthropicTool => {
        // Ensure the map callback returns AnthropicTool
        // Define a fallback schema (JSON Schema object)
        const fallbackSchema: Record<string, any> = {
          // Use Record<string, any> for generic JSON schema
          type: "object",
          properties: {},
        };
        let schemaObject: Record<string, any>; // Use Record<string, any>

        if (typeof tool.input_schema === "string") {
          try {
            const parsedSchema = JSON.parse(tool.input_schema);
            // Basic validation to ensure it looks like an InputSchema
            if (
              typeof parsedSchema === "object" &&
              parsedSchema !== null &&
              "type" in parsedSchema
            ) {
              schemaObject = parsedSchema; // Assign directly
            } else {
              console.error(
                `Parsed input_schema string for tool ${tool.name} is not a valid schema object.`,
                parsedSchema
              );
              schemaObject = fallbackSchema;
            }
          } catch (error) {
            console.error(
              `Error parsing input_schema string for tool ${tool.name}:`,
              error
            );
            schemaObject = fallbackSchema; // Use fallback on parsing error
          }
        } else if (
          typeof tool.input_schema === "object" &&
          tool.input_schema !== null
        ) {
          // Basic validation for existing object
          if ("type" in tool.input_schema) {
            schemaObject = tool.input_schema; // Assign directly
          } else {
            console.error(
              `Provided input_schema object for tool ${tool.name} is missing 'type' property.`,
              tool.input_schema
            );
            schemaObject = fallbackSchema;
          }
        } else {
          console.error(
            `Invalid input_schema type for tool ${
              tool.name
            }: expected string or object, got ${typeof tool.input_schema}`
          );
          schemaObject = fallbackSchema; // Use fallback for invalid types
        }

        // Always return a valid AnthropicTool structure
        return {
          name: tool.name,
          description: tool.description,
          // Cast schemaObject to 'any' to satisfy the strict InputSchema type expected by AnthropicTool,
          // relying on our runtime checks to ensure it has the necessary 'type' property.
          input_schema: schemaObject as any,
        };
      });
    }

    const response = await this.generateResponse({
      model: chat.model,
      messages: messagesToSend, // Pass the combined messages
      maxTokens: chat.maxTokens || undefined,
      budgetTokens: chat.budgetTokens || undefined,
      systemPrompt: chat.systemPrompt || undefined,
      thinkingMode: (chat.budgetTokens ?? 0) > 0,
      tools: formattedTools, // Pass formatted tools
    });

    return {
      role: response.role,
      content: response.content,
      usage: response.usage,
    };
  }

  // sendMCPChat method is removed as tool handling is now integrated into sendChat/generateResponse
}
