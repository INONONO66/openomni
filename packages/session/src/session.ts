export namespace Session {
  export interface Info {
    id: string;
    title: string;
    model: {
      providerID: string;
      modelID: string;
    };
    time: {
      created: number;
      updated: number;
    };
  }
}
