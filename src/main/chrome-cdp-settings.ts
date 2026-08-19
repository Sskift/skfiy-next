export interface ChromeCdpEndpointInput {
  argv: string[];
  env: {
    SKFIY_CHROME_CDP_ENDPOINT?: string;
  };
}

const CHROME_CDP_ARG = "--skfiy-chrome-cdp-endpoint";

export function readChromeCdpEndpoint(input: ChromeCdpEndpointInput): string | undefined {
  const cliEndpoint = readCliEndpoint(input.argv);
  if (cliEndpoint) {
    return cliEndpoint;
  }

  return readEndpointString(input.env.SKFIY_CHROME_CDP_ENDPOINT);
}

function readCliEndpoint(argv: string[]): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === CHROME_CDP_ARG) {
      return readEndpointString(argv[index + 1]);
    }

    if (arg.startsWith(`${CHROME_CDP_ARG}=`)) {
      return readEndpointString(arg.slice(CHROME_CDP_ARG.length + 1));
    }
  }

  return undefined;
}

function readEndpointString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
