import CommonExample from "~common/models/Example";
import { Attr, Model } from "~client/utils/decorators";

@Model({ className: "Example", collectionName: "examples" })
export default class Example extends CommonExample {

    @Attr({ cascade: false })
    public override name: string = "test";

    @Attr()
    public exampleClient: string = "test";
}
