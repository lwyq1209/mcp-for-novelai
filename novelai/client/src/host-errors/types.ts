import type { AppLanguage } from "../types";

/**
 * One message of the host error catalog (step 4a, user decision 10): the text of an error code or reason in each
 * interface language. {name} is replaced by the error's params.name.
 */
export type HostErrorText = Record<AppLanguage, string>;
export type HostErrorTexts = Readonly<Record<string, HostErrorText>>;
