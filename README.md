# Psychic spec helpers

This repo provides spec helpers to be used in conjunction with the [Dream ORM](https://github.com/rvohealth/dream).

## Getting started

1. Add this repo as a dev dependency in your psychic project (this is done by default for psychic apps, but worth mentioning in case it has been removed from your repo).

```bash
yarn add --dev @rvohealth/dream-spec-helpers
```

2. import dream spec helpers in your jest setup. If you are using dream and psychic together (which is the default and recommended setup), you can import the `@rvohealth/psychic-spec-helpers` package, which will automatically bring in `@rvohealth/dream-spec-helpers`. This is the recommended way to bring in this package, and is automatically set up when provisioning a new psychic app, so you should only need to do this with an a-typical setup.

```ts
// spec/unit/setup/hooks.ts
import "@rvohealth/psychic-spec-helpers";
...
```

If you are using dream _without_ psychic (not recommended), then you can simply import the dream spec helpers at the top of your hooks file, like so:

```ts
// spec/unit/setup/hooks.ts
import "@rvohealth/dream-spec-helpers";
...
```

3. use the spec helpers throughout your app

```ts
describe("V1/Host/PlacesController", () => {
  let user: User;
  let host: Host;

  beforeEach(async () => {
    await request.init(PsychicServer);
    user = await createUser();
  });

  describe("POST v1/hosts/places", () => {
    function subject(expectedStatus: number = 204) {
      return request.post("/v1/host/places", expectedStatus, {
        headers: addEndUserAuthHeader(request, user, {}),
      });
    }

    it("creates a HostPlace join model for the host", async () => {
      const place = await createPlace({ style: "cabin", name: "My cabin" });
      await subject();

      const hostPlace = await HostPlace.firstOrFail();

      // toMatchDreamModel is provided by this spec helper repo.
      expect(hostPlace.user).toMatchDreamModel(user);
    });
  });
});
```

## Questions?

- **Ask them on [Stack Overflow](https://stackoverflow.com)**, using the `[dream]` tag.

## Contributing

Dream is an open source library, so we encourage you to actively contribute. Visit our [Contributing](https://github.com/rvohealth/dream-spec-helpers/CONTRIBUTING.md) guide to learn more about the processes we use for submitting pull requests or issues.

Are you trying to report a possible security vulnerability? Visit our [Security Policy](https://github.com/rvohealth/dream-spec-helpers/SECURITY.md) for guidelines about how to proceed.
