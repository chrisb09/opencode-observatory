import { Collector } from "../metadata.js";
type AnyEvent = {
    type?: string;
    data?: any;
    properties?: any;
    created?: number;
};
export declare function observeEvent(event: AnyEvent, collector: Collector): void;
export {};
