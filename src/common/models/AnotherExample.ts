import Example from "~env/models/Example";
import { Attr, AttrObserver } from "~common/utils/decorators";

export default abstract class AnotherExample extends Example {

    @Attr()
    public anotherExampleCommon: number[] = [];

    @AttrObserver("anotherExampleCommon", "add")
    protected onAnotherExampleCommonAdd(value: number) {
        console.log(value);
    }
}